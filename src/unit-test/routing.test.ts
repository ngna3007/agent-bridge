import { describe, expect, test } from "bun:test";
import { RoutingError, resolveRecipients } from "../routing";
import type { RoutingState } from "../routing";
import type { AgentId, BridgeMessage, Origin } from "../types";

function env(over: Partial<BridgeMessage> & { from: Origin }): BridgeMessage {
  return {
    id: "m1",
    to: null,
    kind: "reply",
    content: "x",
    timestamp: 0,
    ...over,
  };
}

function state(over: Partial<RoutingState> = {}): RoutingState {
  return {
    knownAgents: () => ["claude", "grok", "codex"] as AgentId[],
    senderOf: () => null,
    activeRequesterFor: () => null,
    ...over,
  };
}

describe("resolveRecipients", () => {
  test("an explicit AgentId routes to exactly that agent", () => {
    expect(resolveRecipients(env({ from: "codex", to: "grok" }), state(), 0)).toEqual(["grok"]);
  });

  test("an explicit address equal to the sender throws rather than looping back", () => {
    expect(() => resolveRecipients(env({ from: "codex", to: "codex" }), state(), 0)).toThrow(
      RoutingError,
    );
    expect(() => resolveRecipients(env({ from: "codex", to: "codex" }), state(), 0)).toThrow(
      /codex/,
    );
  });

  test("a directed send to an agent that has never connected is refused, not accepted", () => {
    // isAgentId says the name is well-formed, not that anything answers
    // to it. Accepting this lazily created a mailbox, enqueued the entry,
    // failed the wake-up harmlessly — and returned "delivered" to a
    // sender whose message was parked where nobody will ever drain it.
    const s = state({ knownAgents: () => ["claude", "codex"] as AgentId[] });
    expect(() => resolveRecipients(env({ from: "codex", to: "grok" }), s, 0)).toThrow(RoutingError);
    expect(() => resolveRecipients(env({ from: "codex", to: "grok" }), s, 0)).toThrow(/never connected/);
  });

  test("a directed send to a known-but-detached agent still routes — the mailbox is the point", () => {
    // "Known", not "attached": an agent mid-reconnect, or one that
    // connects later, legitimately drains what accumulated for it.
    const s = state({ knownAgents: () => ["claude", "grok", "codex"] as AgentId[] });
    expect(resolveRecipients(env({ from: "codex", to: "grok" }), s, 0)).toEqual(["grok"]);
  });

  test("the self-address guard is checked before membership, so the message names the real bug", () => {
    const s = state({ knownAgents: () => ["claude"] as AgentId[] });
    expect(() => resolveRecipients(env({ from: "codex", to: "codex" }), s, 0)).toThrow(
      /addressed itself/,
    );
  });

  test('"*" broadcast still excludes only the sender, unaffected by the self-address guard', () => {
    expect(resolveRecipients(env({ from: "codex", to: "*" }), state(), 0)).toEqual([
      "claude",
      "grok",
    ]);
  });

  test('"*" broadcasts to every known agent except the sender', () => {
    expect(resolveRecipients(env({ from: "codex", to: "*" }), state(), 0)).toEqual([
      "claude",
      "grok",
    ]);
  });

  test("inReplyTo routes to the sender of the message it answers", () => {
    const s = state({ senderOf: (id, replier) => (id === "m0" && replier === "codex" ? "claude" : null) });
    expect(resolveRecipients(env({ from: "codex", inReplyTo: "m0" }), s, 0)).toEqual(["claude"]);
  });

  test("an unresolvable inReplyTo throws rather than broadcasting", () => {
    expect(() => resolveRecipients(env({ from: "codex", inReplyTo: "gone" }), state(), 0)).toThrow(
      RoutingError,
    );
  });

  test("mid-turn output routes to that turn's requester", () => {
    const s = state({ activeRequesterFor: (a) => (a === "codex" ? "grok" : null) });
    expect(resolveRecipients(env({ from: "codex" }), s, 0)).toEqual(["grok"]);
  });

  test("inReplyTo beats activeRequester — causality wins over turn state", () => {
    const s = state({
      senderOf: () => "claude",
      activeRequesterFor: () => "grok",
    });
    expect(resolveRecipients(env({ from: "codex", inReplyTo: "m0" }), s, 0)).toEqual(["claude"]);
  });

  test("genuinely spontaneous output falls through to broadcast", () => {
    expect(resolveRecipients(env({ from: "codex" }), state(), 0)).toEqual(["claude", "grok"]);
  });

  test('routing uses "known", not "attached" — a detached agent still resolves', () => {
    const s = state({ knownAgents: () => ["claude", "grok", "codex"] });
    expect(resolveRecipients(env({ from: "claude", to: "grok" }), s, 0)).toEqual(["grok"]);
  });

  test("a system notice broadcasts and is never routed by turn state", () => {
    const s = state({ activeRequesterFor: () => "grok" });
    expect(resolveRecipients(env({ from: "system" }), s, 0)).toEqual([
      "claude",
      "grok",
      "codex",
    ]);
  });
});
