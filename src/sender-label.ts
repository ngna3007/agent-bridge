import type { BridgeMessage } from "./types";

/**
 * How a delivered message says who wrote it.
 *
 * Every agent on the bus receives text, and text alone does not carry a
 * sender. Claude's `get_messages` had prefixed the sender since there
 * were two agents; the proxied agents did not, so an injected turn from
 * Claude, from Grok, or from the human's own bridge all arrived at Codex
 * looking identical — a bare user turn. With one peer that was merely
 * imprecise. With three it is wrong: "who asked me this" is not
 * recoverable from the prompt, and a reply routed by `activeRequester`
 * can go back to someone the responder never thought it was addressing.
 *
 * One function rather than a format string at each delivery point. The
 * label is what a reader keys off to know who they are talking to, so
 * three transports agreeing on it by coincidence is the drift case worth
 * designing out — a proxied agent whose prefix says `codex:` while
 * Claude's says `[codex]` teaches each side a different name for the
 * same peer.
 */
export function withSenderLabel(message: BridgeMessage): string {
  return `[${message.from}] ${message.content}`;
}
