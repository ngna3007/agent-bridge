import { describe, expect, test } from "bun:test";
import { Mailbox } from "../mailbox";
import { MessageBus, SendRejected } from "../message-bus";
import { MessageIndex } from "../message-index";
import { TransportRegistry } from "../wakeup-transport";
import type { AgentId, BridgeMessage } from "../types";

function harness(opts: { capacity?: number; indexCapacity?: number } = {}) {
  const boxes = new Map<AgentId, Mailbox>();
  const mailboxFor = (agent: AgentId) => {
    let box = boxes.get(agent);
    if (!box) {
      let n = 0;
      box = new Mailbox(agent, {
        capacity: opts.capacity ?? 10,
        leaseTimeoutMs: 30_000,
        nextId: () => `${agent}_gap${++n}`,
      });
      boxes.set(agent, box);
    }
    return box;
  };
  const index = new MessageIndex({ capacity: opts.indexCapacity ?? 100, ttlMs: 600_000 });
  const transports = new TransportRegistry();
  const woke: string[] = [];
  const logs: string[] = [];
  const bus = new MessageBus({
    mailboxFor,
    index,
    state: {
      knownAgents: () => ["claude", "grok", "codex"],
      senderOf: (id, replier, now) => index.resolveSender(id, replier, now),
      activeRequesterFor: () => null,
    },
    transports,
    log: (m) => logs.push(m),
  });
  return { bus, boxes, mailboxFor, index, transports, woke, logs };
}

function env(over: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id: "m1",
    from: "codex",
    to: null,
    kind: "reply",
    content: "x",
    timestamp: 0,
    ...over,
  };
}

describe("MessageBus.route", () => {
  test("enqueues into every resolved mailbox before waking anyone", async () => {
    const h = harness();
    const order: string[] = [];
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => {
        order.push(`wake:${h.mailboxFor("claude").size}`);
      },
    });
    await h.bus.route(env({ to: "claude" }), 0);
    // The mailbox already holds it at wake-up time. Ordering is enforced,
    // not asserted.
    expect(order).toEqual(["wake:1"]);
  });

  test("require_reply is refused when the message fans out", async () => {
    // `require_reply` names one agent to wait on. A broadcast that
    // reached three and recorded one obligation would tell the sender
    // something untrue about two of them, and only the first transport
    // to run would carry the instruction.
    const h = harness();
    await expect(h.bus.route(env({ to: "*" }), 0, { requireReply: true })).rejects.toThrow(
      SendRejected,
    );
    // Refused before enqueue: nothing was half-sent.
    expect(h.mailboxFor("claude").size).toBe(0);
    expect(h.mailboxFor("grok").size).toBe(0);
  });

  test("require_reply passes when exactly one recipient resolves", async () => {
    const h = harness();
    const result = await h.bus.route(env({ to: "claude" }), 0, { requireReply: true });
    expect(result.accepted).toEqual(["claude"]);
  });

  test("an implicit fan-out is refused the same way an explicit one is", async () => {
    // No `to`, no `inReplyTo`, no active requester — this resolves to
    // everyone else just as `to: "*"` does. The check lives here, after
    // resolution, precisely because the frontend cannot tell them apart.
    const h = harness();
    await expect(h.bus.route(env({ to: null }), 0, { requireReply: true })).rejects.toThrow(
      /exactly one recipient/,
    );
  });

  test("a wake-up that throws still leaves the message drainable", async () => {
    const h = harness();
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw new Error("gate closed"); },
    });
    await h.bus.route(env({ to: "claude" }), 0);
    expect(h.mailboxFor("claude").drain(1).messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("a full mailbox for one recipient does not block another", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    const result = await h.bus.route(env({ to: "*" }), 0);
    expect(result.accepted).toEqual(["grok"]);
    expect(result.rejected.map((r) => r.agent)).toEqual(["claude"]);
    expect(h.mailboxFor("grok").size).toBe(1);
  });

  test("a reply rejected by every recipient throws SendRejected", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    await expect(h.bus.route(env({ to: "claude" }), 0)).rejects.toThrow(SendRejected);
  });

  test("the index lists only the recipients that accepted", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    await h.bus.route(env({ to: "*" }), 0);
    expect(h.index.resolveSender("m1", "grok", 1)).toBe("codex");
    expect(h.index.resolveSender("m1", "claude", 1)).toBeNull();
  });

  test("an index failure rolls back the enqueue, fires no wake-up, and fails the send", async () => {
    const h = harness({ indexCapacity: 1 });
    let woke = 0;
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { woke++; },
    });
    // Fill the index with one live entry so the second record() is refused.
    await h.bus.route(env({ id: "first", to: "claude" }), 0);
    h.mailboxFor("claude").drain(1);
    await expect(h.bus.route(env({ id: "second", to: "claude" }), 1)).rejects.toThrow(SendRejected);
    expect(woke).toBe(1); // only the first route woke anyone
    expect(h.mailboxFor("claude").drain(30_002).messages.map((m) => m.id)).toEqual(["first"]);
  });

  test("a broadcast rejected by every mailbox writes no index entry", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "f1" }));
    h.mailboxFor("grok").enqueue(env({ id: "f2" }));
    await expect(h.bus.route(env({ to: "*" }), 0)).rejects.toThrow(SendRejected);
    expect(h.index.resolveSender("m1", "grok", 1)).toBeNull();
  });
});
