import { describe, expect, test } from "bun:test";
import { dispositionFor, lifecycleTagFor } from "../inbound-disposition";

describe("lifecycleTagFor", () => {
  test("a system_* id resolves to its status-line tag", () => {
    expect(lifecycleTagFor("system_turn_completed_1717000000000")).not.toBeNull();
  });

  test("an ordinary message id is not a lifecycle event", () => {
    expect(lifecycleTagFor("msg_1717000000000_4")).toBeNull();
  });

  test("a notice id is not a lifecycle event — it is content the sender must read", () => {
    expect(lifecycleTagFor("notice_reply_expired_7")).toBeNull();
  });
});

describe("dispositionFor", () => {
  test("a lifecycle id is a status-line tag whatever the hint says", () => {
    const d = dispositionFor("system_ready_1717000000000", "queue");
    expect(d.kind).toBe("lifecycle");
  });

  test('hint "queue" holds the message for get_messages instead of pushing it', () => {
    // The bug this pins: the daemon computed this hint, put it on the
    // wire and the client re-emitted it, but bridge.ts's handler bound
    // only the message parameter — so every untagged Codex line pushed
    // into Claude's context while message-filter's contract text, which
    // is injected into Codex, told Codex the line had been queued.
    expect(dispositionFor("msg_1717000000000_4", "queue")).toEqual({ kind: "queue" });
  });

  test('hint "push" wakes Claude', () => {
    expect(dispositionFor("msg_1717000000000_4", "push")).toEqual({ kind: "push" });
  });

  test("no hint means an older daemon, and pushes", () => {
    // Version skew must not invent a message nobody knows to look for.
    expect(dispositionFor("msg_1717000000000_4", undefined)).toEqual({ kind: "push" });
  });
});
