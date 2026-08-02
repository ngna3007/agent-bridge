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
    expect(await r.wake("claude", m, () => {})).toBe(true);
    expect(seen).toEqual(["m1"]);
  });

  test("an agent with no transport is not an error — the message is in the mailbox", async () => {
    const r = new TransportRegistry();
    expect(await r.wake("grok", m, () => {})).toBe(false);
  });

  test("a wake-up that throws is logged and swallowed", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw new Error("socket closed"); },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe(false);
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
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe(false);
    expect(logs.join()).toMatch(/gate closed/);
  });
});
