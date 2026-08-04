import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

describe("get_messages is a transport, not a store", () => {
  test("drains from the daemon and acks exactly what it returned", async () => {
    const acks: { batchId: string; ids: string[] }[] = [];
    const adapter = new ClaudeAdapter("/dev/null");
    adapter.setMailbox({
      drain: async () => ({
        batchId: "b1",
        messages: [
          { id: "m1", from: "codex", to: "claude", kind: "reply", content: "a", timestamp: 0 },
        ],
      }),
      ack: (batchId, ids) => acks.push({ batchId, ids }),
    });

    const result = await adapter.handleGetMessages();
    expect(result).toMatch(/a/);
    expect(acks).toEqual([{ batchId: "b1", ids: ["m1"] }]);
  });

  test("an empty drain acks nothing", async () => {
    const acks: unknown[] = [];
    const adapter = new ClaudeAdapter("/dev/null");
    adapter.setMailbox({
      drain: async () => ({ batchId: "b2", messages: [] }),
      ack: (...args) => acks.push(args),
    });
    await adapter.handleGetMessages();
    expect(acks).toHaveLength(0);
  });

  test("the adapter keeps no messages of its own", () => {
    const adapter = new ClaudeAdapter("/dev/null") as unknown as Record<string, unknown>;
    expect(adapter.pendingMessages).toBeUndefined();
  });

  test("no mailbox registered surfaces as a clear message rather than a crash", async () => {
    const adapter = new ClaudeAdapter("/dev/null");
    const result = await adapter.handleGetMessages();
    expect(result).toBe("AgentBridge is not connected to a daemon.");
  });
});
