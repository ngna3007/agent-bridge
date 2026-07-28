import type { BridgeMessage } from "./types";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  pid: number;
  /**
   * Whether a Claude frontend currently holds the single Claude slot.
   * The daemon has always known this; it was not reported, so `abg
   * status` could not answer the first question anyone asks when the
   * bridge feels stuck — is the other side actually there?
   */
  claudeAttached: boolean;
  /** Claude→Codex replies deferred because Codex was mid-turn. */
  pendingReplyCount: number;
}

/**
 * What the frontend learns about one Claude→Codex reply attempt.
 *
 * Shared by `DaemonClient.sendReply` and the `ReplySender` the adapter
 * calls, so `queued` cannot be reported by the daemon and then dropped
 * on the way to the tool result — which is exactly what "the reply
 * silently vanished" looks like from Claude's side.
 */
export interface ReplyOutcome {
  success: boolean;
  error?: string;
  /** Accepted but held: Codex was mid-turn. Not a failure, not a retry. */
  queued?: boolean;
  /** Extra detail shown to Claude verbatim. */
  note?: string;
}

export type ControlClientMessage =
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  | { type: "status" };

/**
 * How the bridge should surface a codex_to_claude message in Claude's
 * session.
 *
 * - "push" (default): synchronously pushed via the MCP channel, so it
 *   appears in Claude's context the moment it arrives. Used for
 *   [REPLY] events and any system_* lifecycle notice the daemon
 *   wants Claude to act on immediately.
 *
 * - "queue": held in the ClaudeAdapter's pull queue. Claude only sees
 *   it when it explicitly calls the get_messages tool. Used for
 *   untagged Codex output so that not every Codex reply automatically
 *   spends Claude's context tokens.
 */
export type ClaudeDeliveryHint = "push" | "queue";

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage; deliveryHint?: ClaudeDeliveryHint }
  | {
      type: "claude_to_codex_result";
      requestId: string;
      success: boolean;
      error?: string;
      /**
       * True when the message was accepted but held rather than sent:
       * Codex was mid-turn, and the daemon will inject it when that
       * turn completes. Distinct from `success: false` on purpose —
       * the reply is not lost and must not be retried by hand.
       */
      queued?: boolean;
      /** Extra detail for a queued or lossy accept, shown to Claude verbatim. */
      note?: string;
    }
  | { type: "status"; status: DaemonStatus };

/** WebSocket close code sent by the daemon when a newer Claude session replaces the current one. */
export const CLOSE_CODE_REPLACED = 4001;

/**
 * WebSocket close code sent by the daemon when it evicts a stale Claude frontend
 * that failed to respond to a liveness probe. Used by challenge-on-contest admission
 * so a newer session can take over when the OS never surfaced FIN on a dead peer.
 */
export const CLOSE_CODE_EVICTED_STALE = 4002;

/**
 * WebSocket close code sent by the daemon when a contestant arrives while a
 * liveness probe is already in flight against the incumbent. Distinct from
 * CLOSE_CODE_REPLACED so the contestant's UI can suggest retrying shortly
 * (the in-flight probe will conclude within LIVENESS_PROBE_TIMEOUT_MS).
 */
export const CLOSE_CODE_PROBE_IN_PROGRESS = 4003;
