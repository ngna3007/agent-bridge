/**
 * What the foreground bridge does with one inbound `codex_to_claude`.
 *
 * Extracted from `bridge.ts` for the same reason the bus block came out
 * of `daemon.ts`: both are scripts that start listening at import, so
 * neither has a unit-test seam, and the seam between them is where the
 * delivery hint went missing. The daemon computed a hint, put it on the
 * wire, and the client re-emitted it — and the handler bound one
 * parameter, so every untagged Codex line pushed into Claude's context
 * while three separate documents, one of them injected into Codex,
 * described a pull queue. The decision lives here now, where a test can
 * hold it to what the contract says.
 */

import { tagForLifecycle } from "./lifecycle-tags";
import type { ClaudeDeliveryHint } from "./control-protocol";

export type InboundDisposition =
  /** A daemon lifecycle notice: a status-line tag, never chat content. */
  | { kind: "lifecycle"; tag: string }
  /** Wake Claude now — the message appears in its context immediately. */
  | { kind: "push" }
  /** Leave it in the daemon's mailbox for `get_messages` to drain. */
  | { kind: "queue" };

/**
 * Daemon-side `BridgeMessage` ids are formatted as `<prefix>_<ts>`, e.g.
 * `system_waiting_1717000000000`. Extract the prefix and look it up in
 * the shared tag table. Anything `system_*` falls back to a sanitized
 * auto-uppercased tag, so a new event id can never silently leak into
 * Claude's chat.
 */
export function lifecycleTagFor(id: string): string | null {
  const match = /^([a-z_]+?)_\d+$/.exec(id);
  if (!match) return null;
  const prefix = match[1];
  if (!prefix.startsWith("system_")) return null;
  return tagForLifecycle(prefix);
}

/**
 * Decide, from the id and the daemon's hint alone.
 *
 * A push is a wake-up, never a consumption: the message stays in the
 * daemon's mailbox until `get_messages` acks it, so choosing `"queue"`
 * costs latency and not the message. That is what makes honouring the
 * hint safe — the pull path is the same mailbox, and the `[CODEX READY]`
 * status-line tag on turn completion is the cue to drain it.
 *
 * A missing hint means an older daemon that never computed one. Push is
 * the right default there: it is what that daemon's frontends did, and
 * over-delivery from a version skew is recoverable in a way that a
 * message nobody knows to look for is not.
 */
export function dispositionFor(
  id: string,
  hint: ClaudeDeliveryHint | undefined,
): InboundDisposition {
  const tag = lifecycleTagFor(id);
  if (tag) return { kind: "lifecycle", tag };
  return hint === "queue" ? { kind: "queue" } : { kind: "push" };
}
