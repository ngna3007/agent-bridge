import { describe, expect, test } from "bun:test";
import { MessageIndex } from "../message-index";

function idx(capacity = 10, ttlMs = 60_000) {
  return new MessageIndex({ capacity, ttlMs });
}

describe("provenance index", () => {
  test("resolves a reply back to the original sender", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("m1", "codex", 1_000)).toBe("claude");
  });

  test("outlives the message it describes", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    // no mailbox involvement at all — the index is independent storage
    expect(m.resolveSender("m1", "codex", 59_000)).toBe("claude");
  });

  test("rejects a replier that was not a recipient", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("m1", "grok", 1_000)).toBeNull();
  });

  test("rejects an unknown or expired id", () => {
    const m = idx(10, 1_000);
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("nope", "codex", 10)).toBeNull();
    expect(m.resolveSender("m1", "codex", 2_000)).toBeNull();
  });

  test("a system entry is not a valid reply target", () => {
    const m = idx();
    m.record("s1", { from: "system", recipients: ["claude"], at: 0 }, 0);
    expect(m.resolveSender("s1", "claude", 10)).toBeNull();
  });

  test("re-recording an existing id is rejected and does not replace the entry", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.record("m1", { from: "grok", recipients: ["claude"], at: 500 }, 500)).toBe(false);
    // still resolves against the ORIGINAL recipients, proving no overwrite
    expect(m.resolveSender("m1", "codex", 1_000)).toBe("claude");
    expect(m.resolveSender("m1", "claude", 1_000)).toBeNull();
  });

  test("duplicate id rejection happens below capacity too", () => {
    const m = idx(10, 60_000);
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.record("m1", { from: "codex", recipients: ["claude"], at: 100 }, 100)).toBe(false);
    expect(m.size).toBe(1);
  });

  test("the cap evicts expired entries only", () => {
    const m = idx(2, 1_000);
    m.record("old", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    m.record("live", { from: "claude", recipients: ["codex"], at: 900 }, 900);
    // both live: no room, nothing expired → reject
    expect(m.record("third", { from: "grok", recipients: ["codex"], at: 950 }, 950)).toBe(false);
    expect(m.size).toBe(2);
    // now "old" has expired → it is evicted and the write lands
    expect(m.record("third", { from: "grok", recipients: ["codex"], at: 1_500 }, 1_500)).toBe(true);
    expect(m.resolveSender("old", "codex", 1_500)).toBeNull();
    expect(m.resolveSender("live", "codex", 1_500)).toBe("claude");
  });
});
