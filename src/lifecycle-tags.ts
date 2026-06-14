/**
 * Single source of truth for statusbar lifecycle tags.
 *
 * Three processes used to write status.line:
 *   - bridge.ts emitLifecycle (most of them, color-coded)
 *   - bridge.ts daemonClient.on("codexMessage") fallback for
 *     daemon-emitted system_* events
 *   - daemon.ts shutdown handler (hardcoded [BRIDGE STOPPED])
 *
 * Each used its own tag literal. Drift hazard: bridge could colorize
 * one event blue while daemon's hardcoded fallback for the same
 * symptom said red, etc. This module collapses the three maps into
 * one and gives every caller a single helper to look up the tag.
 */

// ANSI helpers - paired with a trailing RESET so colorization never
// leaks past our tag.
export const C_RESET = "\x1b[0m";
export const C_GREEN = "\x1b[32m";
export const C_YELLOW = "\x1b[33m";
export const C_RED = "\x1b[31m";
export const C_DIM = "\x1b[2m";

export const wrap = (c: string, s: string): string => `${c}${s}${C_RESET}`;

/** Pre-built tag for the daemon's own shutdown path. */
export const BRIDGE_STOPPED_TAG = wrap(C_DIM, "[BRIDGE STOPPED]");

/**
 * The full lifecycle-id -> colored-tag map. Used by bridge.ts when
 * looking up either daemon-originated (system_ready / system_waiting
 * / system_turn_*) or bridge-originated (system_bridge_* /
 * system_daemon_*) events.
 *
 * Unknown ids fall back to a sanitized auto-uppercased version of the
 * id so a new event added on either side never silently leaks into
 * Claude's context - it'll just show as a plain bracketed string in
 * the statusbar.
 */
export const LIFECYCLE_TAGS: Record<string, string> = {
  // Bridge-side lifecycle events.
  system_tui_kickoff:                   wrap(C_GREEN,  "[CODEX READY]"),
  system_daemon_disconnected:           wrap(C_RED,    "[BRIDGE OFFLINE]"),
  system_daemon_reconnected:            wrap(C_GREEN,  "[CODEX READY]"),
  system_bridge_ready:                  wrap(C_GREEN,  "[BRIDGE READY]"),
  system_daemon_connect_failed:         wrap(C_RED,    "[BRIDGE FAILED]"),
  system_bridge_evicted:                wrap(C_RED,    "[REPLACED BY NEWER SESSION]"),
  system_bridge_probe_in_progress:      wrap(C_YELLOW, "[RECONNECTING]"),
  system_bridge_replaced:               wrap(C_RED,    "[ANOTHER SESSION ACTIVE]"),
  system_bridge_disabled:               BRIDGE_STOPPED_TAG,
  system_bridge_auto_recovery_gave_up:  wrap(C_RED,    "[RECONNECT FAILED]"),
  system_bridge_recovered:              wrap(C_GREEN,  "[CODEX READY]"),
  // Daemon-side lifecycle events forwarded through the codex_to_claude
  // channel as system_* ids.
  system_ready:                         wrap(C_GREEN,  "[CODEX READY]"),
  system_waiting:                       wrap(C_YELLOW, "[WAITING FOR CODEX]"),
  system_codex_start_failed:            wrap(C_RED,    "[CODEX FAILED]"),
  system_turn_started:                  wrap(C_YELLOW, "[CODEX THINKING]"),
  system_turn_completed:                wrap(C_GREEN,  "[CODEX READY]"),
  system_reply_missing:                 wrap(C_RED,    "[CODEX NO REPLY]"),
  system_tui_disconnected:              wrap(C_YELLOW, "[CODEX UI OFFLINE]"),
  system_tui_reconnected:               wrap(C_GREEN,  "[CODEX READY]"),
};

/**
 * Resolve a lifecycle event id to its statusbar tag. Unknown ids get
 * a sanitized auto-uppercased fallback - shows the event name in
 * brackets instead of leaking into Claude's chat.
 */
export function tagForLifecycle(id: string): string {
  if (id in LIFECYCLE_TAGS) return LIFECYCLE_TAGS[id];
  return `[${id.replace(/^system_/, "").toUpperCase()}]`;
}

/**
 * Set of ids the daemon side originates (so bridge.ts can detect
 * "this came from the daemon, not from a local bridge action" when
 * routing through the codex_to_claude stream).
 */
export const DAEMON_LIFECYCLE_IDS: ReadonlySet<string> = new Set([
  "system_ready",
  "system_waiting",
  "system_codex_start_failed",
  "system_turn_started",
  "system_turn_completed",
  "system_reply_missing",
  "system_tui_disconnected",
  "system_tui_reconnected",
]);
