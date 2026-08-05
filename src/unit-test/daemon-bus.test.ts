import { describe, expect, test } from "bun:test";
import {
  deliveryHintFor,
  registerTransport,
  routeThroughBus,
  senderFacingText,
  type RouteOutcome,
} from "../daemon-bus";
import { SendRejected } from "../message-bus";
import { RoutingError } from "../routing";
import { TransportRegistry, type WakeupTransport } from "../wakeup-transport";
import type { AgentId, BridgeMessage } from "../types";

function envelope(over: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id: "m1",
    source: "codex",
    content: "hello",
    timestamp: 1,
    from: "codex",
    to: null,
    kind: "untagged",
    ...over,
  };
}

describe("deliveryHintFor", () => {
  test("a [REPLY] pushes", () => {
    expect(deliveryHintFor(envelope({ kind: "reply" }), "filtered")).toBe("push");
  });

  test("[STATUS] and [FYI] queue", () => {
    expect(deliveryHintFor(envelope({ kind: "status" }), "filtered")).toBe("queue");
    expect(deliveryHintFor(envelope({ kind: "fyi" }), "filtered")).toBe("queue");
  });

  test("untagged agent output queues — it is pull-only by contract", () => {
    expect(deliveryHintFor(envelope({ kind: "untagged", from: "codex" }), "filtered")).toBe("queue");
  });

  test("an untagged daemon notice pushes — it drives the status line", () => {
    expect(deliveryHintFor(envelope({ kind: "untagged", from: "system" }), "filtered")).toBe("push");
  });

  test("full mode pushes every kind, including the ones filtered mode queues", () => {
    for (const kind of ["reply", "status", "fyi", "untagged"] as const) {
      expect(deliveryHintFor(envelope({ kind }), "full")).toBe("push");
    }
  });
});

describe("senderFacingText", () => {
  test("a clean delivery owes the sender nothing", () => {
    expect(senderFacingText({ status: "delivered", accepted: ["claude"] })).toBeNull();
  });

  test("a partial shed hands back the note", () => {
    const outcome: RouteOutcome = { status: "partial", note: "grok's mailbox is full", accepted: ["claude"] };
    expect(senderFacingText(outcome)).toBe("grok's mailbox is full");
  });

  test("a failure hands back the error", () => {
    expect(senderFacingText({ status: "failed", error: "nope" })).toBe("nope");
  });
});

describe("routeThroughBus", () => {
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);

  test("no rejections is a clean delivery", async () => {
    const bus = { route: async () => ({ id: "m1", accepted: ["claude" as AgentId], rejected: [] }) };
    expect(await routeThroughBus({ bus, log }, envelope())).toEqual({
      status: "delivered",
      accepted: ["claude"],
    });
  });

  test("a mixed result is partial, and the note names every rejection", async () => {
    const bus = {
      route: async () => ({
        id: "m1",
        accepted: ["claude" as AgentId],
        rejected: [
          { agent: "grok" as AgentId, reason: "grok's mailbox is full." },
          { agent: "codex" as AgentId, reason: "codex's mailbox is full." },
        ],
      }),
    };
    const outcome = await routeThroughBus({ bus, log }, envelope());
    expect(outcome.status).toBe("partial");
    expect(senderFacingText(outcome)).toBe("grok's mailbox is full. codex's mailbox is full.");
  });

  test("RoutingError becomes a failure carrying its own message", async () => {
    const bus = {
      route: async () => {
        throw new RoutingError("unknown recipient zork");
      },
    };
    expect(await routeThroughBus({ bus, log }, envelope())).toEqual({
      status: "failed",
      error: "unknown recipient zork",
    });
  });

  test("SendRejected becomes a failure carrying its own message", async () => {
    const bus = {
      route: async () => {
        throw new SendRejected("mailbox full");
      },
    };
    expect(await routeThroughBus({ bus, log }, envelope())).toEqual({
      status: "failed",
      error: "mailbox full",
    });
  });

  test("an unexpected throw is a failure, but is not reported as a routing verdict", async () => {
    const bus = {
      route: async () => {
        throw new TypeError("undefined is not a function");
      },
    };
    const outcome = await routeThroughBus({ bus, log }, envelope());
    expect(outcome).toEqual({ status: "failed", error: "The daemon could not route this message." });
  });

  test("the routing timestamp comes from the injected clock", async () => {
    let seen = -1;
    const bus = {
      route: async (_e: BridgeMessage, now: number) => {
        seen = now;
        return { id: "m1", accepted: ["claude" as AgentId], rejected: [] };
      },
    };
    await routeThroughBus({ bus, log, now: () => 4242 }, envelope());
    expect(seen).toBe(4242);
  });
});

describe("registerTransport", () => {
  function harness() {
    const removed: { agent: AgentId; ids: string[] }[] = [];
    const transports = new TransportRegistry();
    return {
      transports,
      removed,
      deps: {
        transports,
        mailboxFor: (agent: AgentId) => ({
          remove: (ids: string[]) => {
            removed.push({ agent, ids });
            return ids.length;
          },
        }),
      },
    };
  }

  test('an "explicit" transport is registered untouched — nothing self-acks for it', async () => {
    const h = harness();
    const woken: string[] = [];
    const transport: WakeupTransport = {
      payloadMode: "content",
      acknowledgementMode: "explicit",
      wake: (m) => void woken.push(m.id),
    };
    registerTransport(h.deps, "claude", transport);
    await h.transports.wake("claude", envelope(), () => {});
    expect(woken).toEqual(["m1"]);
    expect(h.removed).toEqual([]);
  });

  test('a "none" transport self-acks on a successful wake', async () => {
    const h = harness();
    registerTransport(h.deps, "codex", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => {},
    });
    await h.transports.wake("codex", envelope(), () => {});
    expect(h.removed).toEqual([{ agent: "codex", ids: ["m1"] }]);
  });

  test('a "none" transport that throws keeps the mailbox entry', async () => {
    const h = harness();
    registerTransport(h.deps, "codex", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => {
        throw new Error("app-server is gone");
      },
    });
    const result = await h.transports.wake("codex", envelope(), () => {});
    expect(result).toBe("failed");
    expect(h.removed).toEqual([]);
  });
});
