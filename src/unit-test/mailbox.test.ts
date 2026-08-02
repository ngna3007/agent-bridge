import { describe, expect, test } from "bun:test";
import { Mailbox } from "../mailbox";
import type { BridgeMessage, MessageKind } from "../types";

let seq = 0;
function msg(kind: MessageKind, content = "x"): BridgeMessage {
  return {
    id: `m${++seq}`,
    from: "codex",
    to: "claude",
    kind,
    content,
    timestamp: 1_000,
  };
}

function box(capacity = 3) {
  let n = 0;
  return new Mailbox("claude", {
    capacity,
    leaseTimeoutMs: 30_000,
    nextId: () => `gap${++n}`,
  });
}

describe("mailbox overflow is per-kind and decided before success", () => {
  test("a reply is rejected at send when the mailbox is full", () => {
    const m = box(2);
    expect(m.enqueue(msg("reply")).accepted).toBe(true);
    expect(m.enqueue(msg("reply")).accepted).toBe(true);
    const third = m.enqueue(msg("reply"));
    expect(third.accepted).toBe(false);
    expect(third.reason).toMatch(/claude/);
    expect(m.size).toBe(2);
  });

  test("status collapses the oldest raw entries into one gap entry with its own id", () => {
    const m = box(3);
    m.enqueue(msg("status", "a"));
    m.enqueue(msg("status", "b"));
    m.enqueue(msg("status", "c"));
    expect(m.enqueue(msg("status", "d")).accepted).toBe(true);
    const { messages } = m.drain(2_000);
    expect(messages[0].id).toBe("gap1");
    expect(messages[0].from).toBe("system");
    expect(messages[0].kind).toBe("status");
    expect(messages[0].content).toMatch(/2 status message\(s\) elided/);
    expect(messages.map((x) => x.content)).toEqual([
      messages[0].content,
      "c",
      "d",
    ]);
  });

  test("fyi is droppable and counted", () => {
    const m = box(1);
    m.enqueue(msg("fyi"));
    expect(m.enqueue(msg("fyi")).accepted).toBe(true);
    expect(m.droppedCounts().fyi).toBe(1);
  });

  test("untagged drops the oldest and gap-marks the drain", () => {
    const m = box(1);
    m.enqueue(msg("untagged", "old"));
    m.enqueue(msg("untagged", "new"));
    const { messages } = m.drain(2_000);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toMatch(/1 message\(s\) dropped/);
    expect(messages[1].content).toBe("new");
  });

  test("remove takes entries back out for a rollback", () => {
    const m = box(3);
    const a = msg("reply");
    m.enqueue(a);
    m.remove([a.id]);
    expect(m.size).toBe(0);
  });

  test("status collapse never pushes the mailbox past capacity with mixed-kind traffic", () => {
    // Regression for a partial collapse: a same-kind victim can run out
    // before two slots are free (mixed kinds at capacity 3: only one
    // status entry to collapse). The mailbox must still end at or under
    // capacity, not grow past it.
    const m = box(3);
    m.enqueue(msg("status", "a"));
    m.enqueue(msg("fyi", "b"));
    m.enqueue(msg("reply", "c"));
    expect(m.enqueue(msg("status", "d")).accepted).toBe(true);
    expect(m.size).toBeLessThanOrEqual(3);
  });

  test("status collapse at capacity < 2 skips the gap entry and stays at capacity", () => {
    const m = box(1);
    m.enqueue(msg("status", "a"));
    expect(m.enqueue(msg("status", "b")).accepted).toBe(true);
    expect(m.size).toBeLessThanOrEqual(1);
  });
});
