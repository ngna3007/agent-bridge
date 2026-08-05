import { describe, expect, test } from "bun:test";
import { TransportRegistry } from "../wakeup-transport";
import type { BridgeMessage } from "../types";

const m: BridgeMessage = {
  id: "m1",
  from: "codex",
  to: "claude",
  kind: "reply",
  content: "x",
  timestamp: 0,
};

describe("TransportRegistry", () => {
  test("wakes a registered transport", async () => {
    const seen: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: (msg) => { seen.push(msg.id); },
    });
    expect(await r.wake("claude", m, () => {})).toBe("woken");
    expect(seen).toEqual(["m1"]);
  });

  test("an agent with no transport is not an error — the message is in the mailbox", async () => {
    const r = new TransportRegistry();
    expect(await r.wake("grok", m, () => {})).toBe("no-transport");
  });

  test("a wake-up that throws is logged and swallowed", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw new Error("socket closed"); },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe("failed");
    expect(logs.join()).toMatch(/socket closed/);
  });

  test("a wake-up that rejects is logged and swallowed", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: async () => { throw new Error("gate closed"); },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe("failed");
    expect(logs.join()).toMatch(/gate closed/);
  });

  test("a wake-up that throws a non-Error value is still swallowed with a useful log", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw { code: "ECONNRESET" }; },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe("failed");
    expect(logs.join()).toMatch(/ECONNRESET/);
    expect(logs.join()).not.toMatch(/\[object Object\]/);
  });

  test("unregister removes the transport", async () => {
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => {},
    });
    r.unregister("claude");
    expect(await r.wake("claude", m, () => {})).toBe("no-transport");
  });

  test("get returns null for an agent that was never registered", () => {
    const r = new TransportRegistry();
    expect(r.get("codex")).toBeNull();
  });

  test("re-registering an agent replaces the previous transport", async () => {
    const seen: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { seen.push("old"); },
    });
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { seen.push("new"); },
    });
    expect(await r.wake("claude", m, () => {})).toBe("woken");
    expect(seen).toEqual(["new"]);
  });
});
