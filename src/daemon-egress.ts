import type { BridgeMessage } from "./types";

/**
 * Shape a message for one frontend's declared protocol version.
 *
 * Users upgrade the daemon with `abg` while editor sessions lag, so
 * old-frontend/new-daemon has to keep working: a 0.7 frontend reads
 * `source` and knows nothing about `from`. The reverse direction is one
 * `abg kill` from resolved, which is why the frontend refuses an old
 * daemon outright instead of degrading.
 *
 * The legacy `source` field only ever had the vocabulary `"claude" |
 * "codex"` — it predates both `"system"` (daemon-authored lifecycle
 * notices) and `"grok"` (a third agent identity). A 0.7 frontend has no
 * word for either, so both degrade to `"codex"`: from that frontend's
 * point of view, "not claude" was always "codex", the other party on
 * the bus.
 *
 * `source` is dropped entirely in 0.9.
 */
export function forEgress(message: BridgeMessage, protocolVersion: number | null): BridgeMessage {
  if (protocolVersion !== null && protocolVersion >= 1) {
    const { source: _dropped, ...rest } = message;
    return rest;
  }
  return {
    ...message,
    source: message.from === "claude" ? "claude" : "codex",
  };
}
