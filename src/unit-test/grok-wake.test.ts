import { describe, test, expect } from "bun:test";
import { grokWakeTransport } from "../grok-wake";
import { ReplyObligations } from "../reply-obligations";
import { REPLY_REQUIRED_INSTRUCTION } from "../message-filter";
import type { GrokInjectionCorrelation } from "../grok-adapter";
import type { AgentId, BridgeMessage } from "../types";

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id: "m1",
    from: "claude",
    to: "grok",
    kind: "untagged",
    content: "what is 2+2",
    timestamp: 0,
    ...overrides,
  } as BridgeMessage;
}

function deps(accept: () => boolean) {
  const injected: Array<{ content: string; correlation: GrokInjectionCorrelation }> = [];
  const expected: Array<{ requester: AgentId; messageId: string }> = [];
  const obligations = new ReplyObligations();
  return {
    injected,
    expected,
    obligations,
    transport: grokWakeTransport({
      obligations,
      inject: (content, correlation) => {
        const ok = accept();
        if (ok) injected.push({ content, correlation });
        return ok;
      },
      expectReply: (requester, messageId) => expected.push({ requester, messageId }),
      log: () => {},
    }),
  };
}

describe("grokWakeTransport", () => {
  test("a wake with no session leaves the obligation for the retry", () => {
    // The failure that made this module worth extracting. The mailbox keeps
    // the message when the wake throws, so a later drain delivers it — but
    // the obligation used to be gone by then, and the retry handed Grok a
    // message with no reply instruction and nothing waiting for an answer.
    let live = false;
    const { transport, obligations, injected, expected } = deps(() => live);
    obligations.require("m1", 0);

    expect(() => transport.wake(message())).toThrow(/no live session/);
    expect(injected).toEqual([]);
    expect(expected).toEqual([]);
    // Untouched: nothing was handed over, so nothing was discharged.
    expect(obligations.has("m1")).toBe(true);

    // The TUI connects and the backlog drains.
    live = true;
    transport.wake(message());

    expect(injected).toHaveLength(1);
    expect(injected[0]?.content).toBe("[claude] what is 2+2" + REPLY_REQUIRED_INSTRUCTION);
    expect(expected).toEqual([{ requester: "claude", messageId: "m1" }]);
    expect(obligations.has("m1")).toBe(false);
  });

  test("the correlation echoes what the sender wrote, not the instruction", () => {
    const { transport, obligations, injected } = deps(() => true);
    obligations.require("m1", 0);
    transport.wake(message());

    expect(injected[0]?.correlation).toEqual({
      messageId: "m1",
      requester: "claude",
      text: "what is 2+2",
    });
  });

  test("no obligation means no instruction and nothing pending", () => {
    const { transport, injected, expected } = deps(() => true);
    transport.wake(message());

    // Grok is told who is asking, same as every other recipient.
    expect(injected[0]?.content).toBe("[claude] what is 2+2");
    expect(expected).toEqual([]);
  });

  test("a non-agent sender is correlated as system and owed nothing", () => {
    // `require_reply` names an agent to wait on; a system-originated
    // message has nobody to hand the answer back to.
    const { transport, obligations, injected, expected } = deps(() => true);
    obligations.require("m1", 0);
    transport.wake(message({ from: "system" as AgentId }));

    expect(injected[0]?.correlation.requester).toBe("system");
    expect(expected).toEqual([]);
  });
});
