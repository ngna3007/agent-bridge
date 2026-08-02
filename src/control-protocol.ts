import type { FrontendAgent } from "./frontend-registry";
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
   * Whether a Claude frontend currently holds Claude's slot. The daemon
   * has always known this; it was not reported, so `abg status` could
   * not answer the first question anyone asks when the bridge feels
   * stuck — is the other side actually there?
   *
   * Kept as its own field rather than derived from `attachedAgents` at
   * every call site, because "is Claude there" drives Codex-facing
   * behavior that no other frontend shares.
   */
  claudeAttached: boolean;
  /**
   * Every agent identity currently holding a frontend slot.
   *
   * There is one slot per agent, so Claude and Grok attach at the same
   * time instead of evicting each other (`docs/scaling-plan.md` §4.1b).
   */
  attachedAgents: FrontendAgent[];
  /** Claude→Codex replies deferred because Codex was mid-turn. */
  pendingReplyCount: number;
  /**
   * Which project this daemon serves — `null` outside a project.
   *
   * Reported so a health probe can ask *whose* daemon answered. Ids
   * hash into 1000 port slots, so two projects can derive the same
   * control port; without this, the loser of that collision attaches
   * to the winner's daemon and its Claude ends up driving another
   * project's Codex with nothing failing anywhere.
   */
  projectId: string | null;
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
  /**
   * `projectId` is the frontend declaring *which project* it belongs
   * to, so the daemon can refuse a frontend that reached it through a
   * port-slot collision rather than quietly wiring it to another
   * project's Codex. Optional: a pre-0.7 frontend does not send it, and
   * single-instance mode has nothing to send.
   *
   * `agent` is the frontend declaring *which agent* it is. Absent means
   * Claude, which is what every pre-0.8 frontend sends and what the
   * daemon assumed unconditionally before Grok turned out to attach
   * through the same MCP surface. The message keeps its `claude_`
   * name for wire compatibility with frontends that predate the field.
   */
  | {
      type: "claude_connect";
      projectId?: string | null;
      agent?: FrontendAgent;
      /**
       * The frontend declaring which envelope shape it speaks. Absent
       * means a pre-0.8 frontend, whose payload `source` field was
       * never authenticated and is therefore ignored rather than
       * treated as a mismatch. Inferring the version from which fields
       * happen to be present is how a partially-upgraded frontend gets
       * silently mis-handled, so it is declared, not sniffed.
       */
      protocolVersion?: number;
    }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  /** Ask the daemon to lease this agent's pending messages. */
  | { type: "drain"; requestId: string }
  /** Confirm what was actually consumed. Only this deletes. */
  | { type: "ack"; batchId: string; ids: string[] }
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
  /** First frame the daemon sends. Its absence tells a new frontend the daemon is old. */
  | { type: "hello"; protocolVersion: number }
  | { type: "drain_result"; requestId: string; batchId: string; messages: BridgeMessage[] }
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
 * WebSocket close code sent by the daemon when a frontend from a
 * different project connects — the data-level half of the identity
 * check in `DaemonLifecycle`. Reaching this means two projects derive
 * the same control port; the connection is refused rather than served,
 * because serving it crosses two repos' messages.
 */
export const CLOSE_CODE_PROJECT_MISMATCH = 4003;

/**
 * WebSocket close code sent by the daemon when a contestant arrives while a
 * liveness probe is already in flight against the incumbent. Distinct from
 * CLOSE_CODE_REPLACED so the contestant's UI can suggest retrying shortly
 * (the in-flight probe will conclude within LIVENESS_PROBE_TIMEOUT_MS).
 */
export const CLOSE_CODE_PROBE_IN_PROGRESS = 4003;
