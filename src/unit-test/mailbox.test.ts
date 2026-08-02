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

describe("leased drain and explicit ack", () => {
  test("a second drain during a live lease returns nothing", () => {
    const m = box(5);
    m.enqueue(msg("reply", "a"));
    const first = m.drain(1_000);
    expect(first.messages).toHaveLength(1);
    expect(m.drain(1_500).messages).toHaveLength(0);
  });

  test("an expired lease redelivers the same id", () => {
    const m = box(5);
    const a = msg("reply", "a");
    m.enqueue(a);
    const first = m.drain(1_000);
    const second = m.drain(1_000 + 30_001);
    expect(second.messages.map((x) => x.id)).toEqual([a.id]);
    expect(second.batchId).not.toBe(first.batchId);
  });

  test("a partial ack redelivers only the unacked ids", () => {
    const m = box(5);
    const a = msg("reply", "a");
    const b = msg("reply", "b");
    m.enqueue(a);
    m.enqueue(b);
    const batch = m.drain(1_000);
    expect(m.ack(batch.batchId, [a.id])).toBe(1);
    const again = m.drain(1_000 + 30_001);
    expect(again.messages.map((x) => x.id)).toEqual([b.id]);
  });

  test("an ack naming a stale batch deletes nothing", () => {
    const m = box(5);
    const a = msg("reply", "a");
    m.enqueue(a);
    const batch = m.drain(1_000);
    m.drain(1_000 + 30_001); // lease expires, entry is re-leased
    expect(m.ack(batch.batchId, [a.id])).toBe(0);
    expect(m.size).toBe(1);
  });

  test("a drain with nothing to serve still reports a pending gap", () => {
    const m = box(1);
    m.enqueue(msg("untagged", "old"));
    m.enqueue(msg("untagged", "new"));
    const batch = m.drain(2_000);
    expect(batch.messages[0].content).toMatch(/dropped/);
    // the marker is reported once, not on every drain
    m.ack(batch.batchId, batch.messages.map((x) => x.id));
    expect(m.drain(3_000).messages).toHaveLength(0);
  });
});

describe("dropOldestFree never evicts a live leased entry", () => {
  test("an untagged arrival is dropped, not an in-flight leased entry, when every entry is leased", () => {
    const m = box(2);
    const a = msg("untagged", "a");
    const b = msg("untagged", "b");
    m.enqueue(a);
    m.enqueue(b);
    const batch = m.drain(1_000); // leases both, unexpired
    expect(batch.messages).toHaveLength(2);

    const before = m.droppedCounts().untagged;
    expect(m.enqueue(msg("untagged", "c")).accepted).toBe(true);

    expect(m.size).toBe(2);
    expect(m.droppedCounts().untagged).toBe(before + 1);
    // both original entries are still there, still leased to `batch` —
    // proof neither was evicted to make room for "c".
    expect(m.ack(batch.batchId, [a.id, b.id])).toBe(2);
  });

  test("a reply is rejected, naming the all-awaiting-ack cause, when every entry is leased", () => {
    const m = box(2);
    m.enqueue(msg("untagged", "a"));
    m.enqueue(msg("untagged", "b"));
    m.drain(1_000);
    const result = m.enqueue(msg("reply", "c"));
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/awaiting ack/);
  });

  test("the capacity invariant holds when every entry stays leased across repeated overflow attempts", () => {
    const m = box(2);
    m.enqueue(msg("untagged", "a"));
    m.enqueue(msg("untagged", "b"));
    m.drain(1_000);
    for (let i = 0; i < 5; i++) {
      m.enqueue(msg("untagged", `x${i}`));
      expect(m.size).toBeLessThanOrEqual(2);
    }
    expect(m.size).toBe(2);
  });
});
