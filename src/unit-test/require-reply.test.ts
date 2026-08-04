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
});
