import { describe, expect, test } from "bun:test";
import { PendingRequests } from "../pending-requests";

describe("requireReply correlation", () => {
  test("a reply naming the request satisfies it", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy("q1", ["claude"])).toHaveLength(1);
    expect(p.size).toBe(0);
  });

  test("a reply routed to the requester satisfies it even without inReplyTo", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy(undefined, ["claude"])).toHaveLength(1);
  });

  test("a reply addressed elsewhere does not satisfy it", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy(undefined, ["grok"])).toHaveLength(0);
    expect(p.size).toBe(1);
  });

  test("two concurrent requests are satisfied independently", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    p.add({ requester: "grok", messageId: "q2", at: 0 });
    expect(p.satisfy("q2", ["grok"]).map((r) => r.requester)).toEqual(["grok"]);
    expect(p.size).toBe(1);
  });

  test("an expired request is reported, not silently forgotten", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.expire(10_000, 5_000).map((r) => r.messageId)).toEqual(["q1"]);
    expect(p.size).toBe(0);
  });

  test("satisfy returns multiple matches oldest-first", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    p.add({ requester: "claude", messageId: "q2", at: 1 });
    // Neither is named by inReplyTo, so both are matched by "routed to
    // the requester" — a single reply can close out more than one
    // outstanding request from the same agent.
    expect(p.satisfy(undefined, ["claude"]).map((r) => r.messageId)).toEqual(["q1", "q2"]);
    expect(p.size).toBe(0);
  });

  test("expire returns multiple matches oldest-first", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    p.add({ requester: "grok", messageId: "q2", at: 100 });
    expect(p.expire(10_000, 5_000).map((r) => r.messageId)).toEqual(["q1", "q2"]);
    expect(p.size).toBe(0);
  });

  test("expire's boundary is inclusive: exactly ttlMs old is not yet expired", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.expire(5_000, 5_000)).toHaveLength(0);
    expect(p.size).toBe(1);
    expect(p.expire(5_001, 5_000).map((r) => r.messageId)).toEqual(["q1"]);
    expect(p.size).toBe(0);
  });
  test("cancel drops the request for a message that never arrived", () => {
    // A turn/start the app-server refused carried a message Codex never
    // saw. Letting its request expire would tell the sender "no reply
    // came", pointing at Codex rather than at the send that failed.
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    p.add({ requester: "grok", messageId: "q2", at: 0 });

    expect(p.cancel("q1")?.requester).toBe("claude");
    expect(p.size).toBe(1);
    // Cancelled, not satisfied: nothing was answered.
    expect(p.satisfy(undefined, ["claude"])).toEqual([]);
    expect(p.size).toBe(1);
  });

  test("cancelling an unknown id changes nothing", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.cancel("nope")).toBeNull();
    expect(p.size).toBe(1);
  });
});
