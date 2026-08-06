import { describe, test, expect } from "bun:test";
import { withSenderLabel } from "../sender-label";
import type { BridgeMessage } from "../types";

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id: "m1",
    from: "claude",
    to: "codex",
    kind: "untagged",
    content: "what is 2+2",
    timestamp: 0,
    ...overrides,
  } as BridgeMessage;
}

describe("withSenderLabel", () => {
  test("names the sender ahead of what they wrote", () => {
    expect(withSenderLabel(message())).toBe("[claude] what is 2+2");
  });

  test("a daemon notice is labelled like any other sender", () => {
    // `from` is the only input. A bus-authored notice is not a special
    // case here — it is a sender, and the reader is owed its name.
    expect(withSenderLabel(message({ from: "system" }))).toBe("[system] what is 2+2");
  });

  test("the content is otherwise untouched", () => {
    // Every recipient reads this as prose; anything else stapled on
    // belongs to the transport that staples it, not to the label.
    const body = "line one\n\n[REPLY] line two";
    expect(withSenderLabel(message({ content: body }))).toBe(`[claude] ${body}`);
  });
});
