import { describe, expect, test } from "bun:test";
import { ReplyOutbox, type QueuedReply } from "../reply-outbox";

function reply(id: string, queuedAt = 0, requireReply = false): QueuedReply {
  return { id, content: `body of ${id}`, requireReply, queuedAt };
}

describe("ReplyOutbox", () => {
  test("accept reports depth and drops nothing under the cap", () => {
    const outbox = new ReplyOutbox({ max: 3, ttlMs: 1000 });

    expect(outbox.accept(reply("a"))).toEqual({ depth: 1, dropped: [] });
    expect(outbox.accept(reply("b"))).toEqual({ depth: 2, dropped: [] });
    expect(outbox.size).toBe(2);
  });

  test("overflow evicts the oldest and hands it back", () => {
    // The eviction has to be *reported*: a silently truncated outbox is
    // indistinguishable from a message that was never sent.
    const outbox = new ReplyOutbox({ max: 2, ttlMs: 1000 });
    outbox.accept(reply("a"));
    outbox.accept(reply("b"));

    const result = outbox.accept(reply("c"));

    expect(result.depth).toBe(2);
    expect(result.dropped.map((r) => r.id)).toEqual(["a"]);
    expect(outbox.peek()?.id).toBe("b");
  });

  test("capacity reports the configured cap, not the current depth", () => {
    // User-facing overflow text names the limit. Reading it off `size`
    // after an eviction would always print the post-drop depth.
    const outbox = new ReplyOutbox({ max: 2, ttlMs: 1000 });
    outbox.accept(reply("a"));
    outbox.accept(reply("b"));
    outbox.accept(reply("c"));

    expect(outbox.capacity).toBe(2);
    expect(outbox.size).toBe(2);
  });

  test("a max below 1 is clamped rather than making the outbox useless", () => {
    const outbox = new ReplyOutbox({ max: 0, ttlMs: 1000 });
    expect(outbox.capacity).toBe(1);
    expect(outbox.accept(reply("a")).depth).toBe(1);
  });

  test("takeNext returns entries oldest-first", () => {
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 1000 });
    outbox.accept(reply("a", 100));
    outbox.accept(reply("b", 200));

    expect(outbox.takeNext(300).reply?.id).toBe("a");
    expect(outbox.takeNext(300).reply?.id).toBe("b");
    expect(outbox.takeNext(300).reply).toBeNull();
  });

  test("takeNext discards expired entries and reports them separately", () => {
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 100 });
    outbox.accept(reply("stale", 0));
    outbox.accept(reply("fresh", 500));

    const result = outbox.takeNext(550);

    expect(result.reply?.id).toBe("fresh");
    expect(result.expired.map((r) => r.id)).toEqual(["stale"]);
  });

  test("an outbox holding only expired entries returns null and reports all of them", () => {
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 100 });
    outbox.accept(reply("a", 0));
    outbox.accept(reply("b", 10));

    const result = outbox.takeNext(1000);

    expect(result.reply).toBeNull();
    expect(result.expired.map((r) => r.id)).toEqual(["a", "b"]);
    expect(outbox.size).toBe(0);
  });

  test("TTL is measured from the original queuedAt across a requeue", () => {
    // A requeue happens when delivery is attempted and Codex turns out
    // to be busy again. Refreshing the timestamp there would let a
    // reply outlive its TTL indefinitely on a busy Codex.
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 100 });
    outbox.accept(reply("a", 0));

    const taken = outbox.takeNext(50);
    expect(taken.reply?.id).toBe("a");

    outbox.requeue(taken.reply!);

    expect(outbox.takeNext(160).reply).toBeNull();
  });

  test("requeue puts the entry back at the front", () => {
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 1000 });
    outbox.accept(reply("a", 0));
    outbox.accept(reply("b", 0));

    const taken = outbox.takeNext(1);
    outbox.requeue(taken.reply!);

    expect(outbox.peek()?.id).toBe("a");
    expect(outbox.size).toBe(2);
  });

  test("requeue past the cap drops from the back, keeping the requeued entry", () => {
    // The requeued entry is the one being actively retried; dropping it
    // to make room for a newer message would lose the older wait.
    const outbox = new ReplyOutbox({ max: 2, ttlMs: 1000 });
    outbox.accept(reply("a", 0));
    const taken = outbox.takeNext(1);
    outbox.accept(reply("b", 0));
    outbox.accept(reply("c", 0));

    outbox.requeue(taken.reply!);

    expect(outbox.size).toBe(2);
    expect(outbox.peek()?.id).toBe("a");
  });

  test("clear empties the outbox and returns everything it held", () => {
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 1000 });
    outbox.accept(reply("a"));
    outbox.accept(reply("b"));

    expect(outbox.clear().map((r) => r.id)).toEqual(["a", "b"]);
    expect(outbox.size).toBe(0);
    expect(outbox.clear()).toEqual([]);
  });

  test("requireReply survives the round trip", () => {
    // The flag decides whether the daemon arms its missing-reply
    // warning, so it must be re-applied at delivery, not at queue time.
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 1000 });
    outbox.accept(reply("a", 0, true));

    expect(outbox.takeNext(1).reply?.requireReply).toBe(true);
  });

  test("content is stored raw, with no decoration applied at queue time", () => {
    // Contract pinning and the require-reply instruction depend on
    // daemon state at *send* time; baking them in here would pin a
    // thread the message may never reach.
    const outbox = new ReplyOutbox({ max: 5, ttlMs: 1000 });
    outbox.accept({ id: "a", content: "plain text", requireReply: true, queuedAt: 0 });

    expect(outbox.takeNext(1).reply?.content).toBe("plain text");
  });
});
