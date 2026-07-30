#!/usr/bin/env bun

import type { ServerWebSocket } from "bun";
import { CodexAdapter } from "./codex-adapter";
import { getRotatingLogger } from "./log-rotator";
import { StatusLineWriter } from "./status-line-writer";
import { BRIDGE_STOPPED_TAG } from "./lifecycle-tags";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
  CLOSE_CODE_PROJECT_MISMATCH,
} from "./control-protocol";
import { probeControlPort, describeControlPortConflict } from "./port-preflight";
import { parsePositiveIntEnv } from "./env-utils";
import { ReplyOutbox, type QueuedReply } from "./reply-outbox";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";
import { probeLiveness as probeLivenessImpl } from "./liveness-probe";
import {
  DEFAULT_FRONTEND_AGENT,
  FRONTEND_AGENTS,
  FrontendRegistry,
  parseFrontendAgent,
} from "./frontend-registry";
import type { FrontendAgent } from "./frontend-registry";

const FRONTEND_AGENT_LIST = FRONTEND_AGENTS.join(", ");

interface ControlSocketData {
  clientId: number;
  /**
   * Which agent this socket declared itself to be, from `claude_connect`.
   *
   * Defaulted at upgrade rather than left unset, because a socket that
   * sends a `claude_to_codex` before its connect has to be attributed to
   * *something*, and Claude is what every frontend was until 0.8.
   */
  agent: FrontendAgent;
  attached: boolean;
  /** When the last pong landed. Diagnostics only — the probe reads `pongCount`. */
  lastPongAt: number;
  /** Pong frames seen on this socket, never reset. See `ProbeTarget.pongCount`. */
  pongCount: number;
  /** Set when the frontend was refused for belonging to another project. */
  rejected?: boolean;
}

/**
 * The project this daemon serves, inherited from the launcher's env
 * (`applyProjectEnv` sets it). `null` in single-instance mode. Reported
 * on /healthz and checked on every Claude attach, so a port-slot
 * collision fails loudly instead of crossing two projects' messages.
 */
const DAEMON_PROJECT_ID = process.env.AGENTBRIDGE_PROJECT_ID ?? null;

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

// Daemon-owned status.line writes. The bridge is the primary writer
// (it owns most lifecycle tags via emitLifecycle), but on shutdown
// the bridge usually died first - so without this the user would see
// a stale [CODEX READY] / [CODEX THINKING] tag long after `abg kill`.
const daemonStatusLine = new StatusLineWriter(stateDir);

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
const ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

const codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

let controlServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * One frontend slot per agent identity.
 *
 * Was a single `attachedClaude` variable until Grok Build turned out to
 * load Claude Code's plugin registry, launch this same MCP server, and
 * land in Claude's slot — see `src/frontend-registry.ts` and
 * `docs/scaling-plan.md` §4.1b.
 */
const frontends = new FrontendRegistry<ServerWebSocket<ControlSocketData>, BridgeMessage>({
  maxBufferedMessages: MAX_BUFFERED_MESSAGES,
  isOpen: (ws) => ws.readyState === WebSocket.OPEN,
  isClosed: (ws) => ws.readyState === WebSocket.CLOSED,
});

/**
 * The socket holding Claude's slot, or null.
 *
 * Claude keeps a named accessor because a handful of behaviors are
 * genuinely Claude-specific rather than per-frontend: every Codex-facing
 * notice names Claude, and Codex's own instructions were written about
 * Claude. Generalizing those is product copy, not bookkeeping, and is
 * deliberately not part of this change.
 */
function claudeSocket(): ServerWebSocket<ControlSocketData> | null {
  return frontends.occupant(DEFAULT_FRONTEND_AGENT);
}
let nextControlClientId = 0;
let nextSystemMessageId = 0;
let codexBootstrapped = false;
let attentionWindowTimer: ReturnType<typeof setTimeout> | null = null;
let inAttentionWindow = false;
let replyRequired = false;
let replyReceivedDuringTurn = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let claudeOnlineNoticeSent = false;
let claudeOfflineNoticeShown = false;
let codexCollaborationKickoffSent = false;
let lastAttachStatusSentTs = 0;
const ATTACH_STATUS_COOLDOWN_MS = 30_000; // Don't re-send status on rapid reattach

// Token-saving: the BRIDGE_CONTRACT_REMINDER content (marker contract +
// git-write prohibition + role guidance) lives in AGENTS.md after
// `abg init` and becomes part of Codex's system prompt at session start.
// System prompt survives /compact, so we don't need to re-inject the
// contract per-message. Default mode is "off" (skip per-msg append).
//
// Modes:
//   "off"    — never append (default; AGENTS.md handles it)
//   "once"   — append on first msg of each Codex thread (legacy mid-state)
//   "always" — append to every msg (legacy backstop for setups without
//              AGENTS.md, or while debugging contract drift)
const PIN_CONTRACT_MODE = (process.env.AGENTBRIDGE_PIN_CONTRACT ?? "off").toLowerCase();
let lastPinnedContractThreadId: string | null = null;

// Liveness probe used by challenge-on-contest admission. Issue #68: OS may never
// surface FIN on a half-open TCP, so readyState alone can't tell us the old peer
// is gone. When a new frontend arrives while a socket is still OPEN, we ping the
// old peer; if no pong within this window, we evict it and accept the new one.
const LIVENESS_PROBE_TIMEOUT_MS = parsePositiveIntEnv(
  "AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS",
  3000,
  log,
);
const LIVENESS_PROBE_POLL_MS = 50;

// Claude→Codex replies that arrived while Codex was mid-turn. Codex
// accepts one turn at a time, so these are held and injected when the
// turn completes rather than bounced back as an error Claude has to
// remember to retry. See src/reply-outbox.ts.
const replyOutbox = new ReplyOutbox({
  max: parsePositiveIntEnv("AGENTBRIDGE_REPLY_QUEUE_MAX", 3, log),
  ttlMs: parsePositiveIntEnv("AGENTBRIDGE_REPLY_QUEUE_TTL_MS", 10 * 60_000, log),
});

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    emitToFrontends(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    emitToFrontends(
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`,
      ),
    );
    codex.injectMessage("✅ Claude Code is still online, bridge restored. Bidirectional communication can continue.");
  },
});

// Route the periodic [STATUS] summary to Claude's pull queue
// instead of pushing it on the MCP channel. Same reasoning as
// untagged Codex output: routine progress should not auto-bloat
// Claude's context. Claude can drain via get_messages if curious.
const statusBuffer = new StatusBuffer((summary) => emitToFrontends(summary, "queue"));

codex.on("turnStarted", () => {
  log("Codex turn started");
  emitToFrontends(
    systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
    ),
  );
});

codex.on("agentMessage", (msg: BridgeMessage) => {
  if (msg.source !== "codex") return;
  const result = classifyMessage(msg.content, FILTER_MODE);

  // Track whether Codex sent a [REPLY] during a require_reply turn,
  // so system_reply_missing fires when it didn't. Only [REPLY] counts
  // as "actually replied" - [STATUS] / [FYI] / untagged don't
  // satisfy a required reply. Tracking is the ONLY effect of
  // replyRequired now; we no longer force-forward every intermediate
  // message. Routing of each message still goes through
  // classifyMessage below.
  if (replyRequired && result.marker === "reply") {
    replyReceivedDuringTurn = true;
  }

  // During attention window, suppress STATUS to give Claude space to respond.
  // Skipped in full mode: full mode's contract is "forward everything", and
  // classifyMessage now reports the real marker there, so without this guard
  // a [STATUS] message would start getting buffered instead of forwarded.
  if (FILTER_MODE !== "full" && inAttentionWindow && result.marker === "status") {
    log(`Codex → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(msg);
    return;
  }

  log(`Codex → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  switch (result.action) {
    case "forward":
      if (result.marker === "reply" && statusBuffer.size > 0) {
        statusBuffer.flush("reply message arrived");
      }
      emitToFrontends(msg);
      // [REPLY] message — give Claude an attention window to respond
      if (result.marker === "reply") {
        startAttentionWindow();
      }
      break;
    case "queue":
      // Untagged Codex output: deliver to Claude's pull queue, not the
      // MCP channel. Claude only sees it when get_messages is called.
      emitToFrontends(msg, "queue");
      break;
    case "buffer":
      statusBuffer.add(msg);
      break;
    case "drop":
      break;
  }
});

codex.on("turnCompleted", () => {
  log("Codex turn completed");
  statusBuffer.flush("turn completed");

  // Check if reply was required but Codex didn't send any agentMessage
  if (replyRequired && !replyReceivedDuringTurn) {
    log("⚠️ Reply was required but Codex did not send any agentMessage");
    emitToFrontends(
      systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set). Codex may not have generated an agentMessage. You may want to retry or rephrase.",
      ),
    );
  }

  // Reset reply-required state
  replyRequired = false;
  replyReceivedDuringTurn = false;

  emitToFrontends(
    systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ),
  );
  startAttentionWindow();

  // Retry Claude-online notice if it was deferred while the turn was in progress.
  if (claudeSocket() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }

  // Deliver anything Claude sent while this turn was running. Last,
  // because the online notice is the handshake that explains what
  // AgentBridge is — a held reply landing before it would arrive with
  // no context. If the notice claimed this slot the drain simply
  // re-queues and goes out when *that* turn ends.
  drainReplyOutbox();
});

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready — thread ${threadId}`);
  log("Bridge fully operational");

  emitToFrontends(
    systemMessage("system_ready", currentReadyMessage()),
  );

  if (claudeSocket() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("tuiConnected", (connId: number) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});

codex.on("tuiDisconnected", (connId: number) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});

codex.on("error", (err: Error) => {
  log(`Codex error: ${err.message}`);
});

codex.on("exit", (code: number | null) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  // Codex thread is gone; next thread needs the contract pinned again.
  lastPinnedContractThreadId = null;
  discardOutboxForLostCodex("the Codex app-server exited");
  emitToFrontends(
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`,
    ),
  );
  broadcastStatus();
});

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json(currentStatus());
      }

      if (url.pathname === "/readyz") {
        return Response.json(currentStatus(), { status: codexBootstrapped ? 200 : 503 });
      }

      if (
        url.pathname === "/ws" &&
        server.upgrade(req, {
          data: {
            clientId: 0,
            agent: DEFAULT_FRONTEND_AGENT,
            attached: false,
            lastPongAt: Date.now(),
            pongCount: 0,
          },
        })
      ) {
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — prevent premature idle disconnects
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount = 0;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>, code: number, reason: string) => {
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, wasAttached=${ws.data.attached})`);
        detachFrontend(ws, "frontend socket closed");
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
      pong: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount++;
      },
    },
  });
}

/**
 * May a frontend declaring `theirs` talk to this daemon?
 *
 * Permissive in exactly one direction: a frontend that sends no id at
 * all (pre-0.7 bundle still sitting in a plugin cache) is served, with
 * a note in the log. Refusing it would break an upgrade path in a way
 * the user cannot diagnose, and that frontend's own launcher already
 * had to pick this control port deliberately.
 */
function acceptsFrontend(theirs: string | null | undefined): boolean {
  if (theirs === undefined) {
    if (DAEMON_PROJECT_ID !== null) {
      log(`Frontend did not declare a project id; serving it as ${DAEMON_PROJECT_ID} (older bundle?).`);
    }
    return true;
  }
  return theirs === DAEMON_PROJECT_ID;
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  // A refused frontend may already have pipelined a reply behind its
  // connect. Nothing from that socket is ours to act on.
  if (ws.data.rejected) return;

  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      if (!acceptsFrontend(message.projectId)) {
        // Refusing here is the last line of defence. `DaemonLifecycle`
        // already declines to adopt a foreign daemon, but a frontend
        // with a hardcoded control port never asks — and a Claude
        // attached to the wrong project's Codex fails silently, which
        // is the one failure mode worth being rude about.
        log(
          `Refusing claude_connect from project ${message.projectId} — ` +
            `this daemon serves ${DAEMON_PROJECT_ID}.`,
        );
        ws.data.rejected = true;
        ws.close(
          CLOSE_CODE_PROJECT_MISMATCH,
          `This daemon serves project ${DAEMON_PROJECT_ID}, not ${message.projectId}. ` +
            `Two projects derive the same control port — run \`abg doctor\`.`,
        );
        return;
      }
      {
        // An agent we do not know cannot be given a slot: the only
        // alternatives are coercing it into Claude's (the exact
        // collision this keying exists to stop) or inventing a slot
        // nothing routes to. Refusing says so where the user can read it.
        const agent = parseFrontendAgent(message.agent);
        if (agent === null) {
          log(`Refusing claude_connect from #${ws.data.clientId} — unknown agent ${JSON.stringify(message.agent)}`);
          ws.data.rejected = true;
          ws.close(
            CLOSE_CODE_PROJECT_MISMATCH,
            `Unknown frontend agent ${JSON.stringify(message.agent)} — this daemon serves ${FRONTEND_AGENT_LIST}.`,
          );
          return;
        }
        ws.data.agent = agent;
        attachFrontend(ws, agent).catch((err) => {
          log(`attachFrontend threw for #${ws.data.clientId}: ${err?.message ?? err}`);
        });
      }
      return;
    case "claude_disconnect":
      detachFrontend(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex": {
      // The source must be the agent this socket declared itself to be.
      // Checking against the declaration rather than the literal
      // `"claude"` keeps the guard meaningful now that more than one
      // agent can hold a slot: a frontend cannot send as its neighbour.
      if (message.message.source !== ws.data.agent) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Codex is not ready. Wait for TUI to connect and create a thread.",
        });
        return;
      }

      const requireReply = !!message.requireReply;
      const content = message.message.content;

      if (deliverToCodex(content, requireReply)) {
        clearAttentionWindow(); // Claude successfully replied, end attention window
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: true,
        });
        return;
      }

      // Codex mid-turn is not a failure, it is a wait. Hold the message
      // and deliver it when the turn completes, so Claude does not have
      // to notice the rejection and retry by hand — the single most
      // common way a reply used to get lost.
      if (codex.turnInProgress) {
        const { depth, dropped } = replyOutbox.accept({
          id: message.message.id,
          content,
          requireReply,
          queuedAt: Date.now(),
        });
        log(`Queued Claude → Codex reply while turn in progress (depth ${depth}, dropped ${dropped.length})`);
        let note =
          depth > 1
            ? `Codex is mid-turn. Held for delivery when the turn ends (${depth} replies now queued, sent in order).`
            : "Codex is mid-turn. Held for delivery when the turn ends.";
        if (dropped.length > 0) {
          note +=
            ` ${dropped.length} older queued repl${dropped.length > 1 ? "ies were" : "y was"}` +
            ` dropped to stay under the ${replyOutbox.capacity}-message limit.`;
        }
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: true,
          queued: true,
          note,
        });
        return;
      }

      const reason = "Injection failed: no active thread or WebSocket not connected.";
      log(`Injection rejected: ${reason}`);
      sendProtocolMessage(ws, {
        type: "claude_to_codex_result",
        requestId: message.requestId,
        success: false,
        error: reason,
      });
      return;
    }
  }
}

/**
 * Decorate a Claude message and inject it as a Codex turn.
 *
 * Every state mutation here happens *after* `injectMessage` returns
 * true. The contract-pin bookkeeping and the require-reply flag used to
 * be set before the attempt, so a rejected injection left the thread
 * marked as already-pinned (the contract would then never be sent) and
 * armed `replyRequired` against Codex's *current* turn — producing a
 * `system_reply_missing` warning for a message Codex never received.
 */
function deliverToCodex(content: string, requireReply: boolean): boolean {
  // Pin contract once per Codex thread. Cuts ~200 tokens per
  // Claude→Codex msg after the first. Falls back to per-msg append
  // when AGENTBRIDGE_PIN_CONTRACT=always (legacy mode for users who
  // see contract drift mid-session).
  const activeThreadId = codex.activeThreadId;
  const needsContract =
    PIN_CONTRACT_MODE === "always" ||
    (PIN_CONTRACT_MODE === "once" && activeThreadId !== lastPinnedContractThreadId);

  let contentToSend = content;
  if (needsContract) contentToSend += "\n\n" + BRIDGE_CONTRACT_REMINDER;
  if (requireReply) contentToSend += REPLY_REQUIRED_INSTRUCTION;

  log(`Forwarding Claude → Codex (${content.length} chars, requireReply=${requireReply}, pinnedContract=${needsContract})`);
  if (!codex.injectMessage(contentToSend)) return false;

  if (needsContract && PIN_CONTRACT_MODE === "once" && activeThreadId) {
    lastPinnedContractThreadId = activeThreadId;
    log(`Pinned BRIDGE_CONTRACT_REMINDER for thread ${activeThreadId.slice(0, 8)}; subsequent msgs skip the reminder`);
  }
  if (requireReply) {
    replyRequired = true;
    replyReceivedDuringTurn = false;
    log(`Reply required flag set for this message`);
  }
  return true;
}

/**
 * Deliver at most one held reply, called when a Codex turn completes.
 *
 * One per completed turn, not a full drain: injecting a second message
 * would be refused anyway (the first just started a new turn), and
 * re-queueing it would only churn. Whatever remains waits for the turn
 * this delivery is about to start.
 */
function drainReplyOutbox(): void {
  const { reply, expired } = replyOutbox.takeNext(Date.now());

  for (const stale of expired) {
    const waitedMin = Math.round((Date.now() - stale.queuedAt) / 60_000);
    log(`Dropping expired queued reply ${stale.id} (waited ~${waitedMin}m)`);
    emitToFrontends(
      noticeMessage(
        "reply_expired",
        `⚠️ A reply you sent while Codex was busy waited ~${waitedMin} minutes and was dropped without being delivered. ` +
          `Codex never saw it. Send it again if it still applies.\n\nDropped message:\n${truncateForNotice(stale.content)}`,
      ),
    );
  }

  if (!reply) return;

  if (deliverToCodex(reply.content, reply.requireReply)) {
    // Same bookkeeping as a live reply: Claude has answered, so the
    // attention window opened moments ago by turnCompleted is over.
    clearAttentionWindow();
    log(`Delivered queued reply ${reply.id} after turn completion`);
    emitToFrontends(
      noticeMessage(
        "reply_delivered",
        "📤 The reply you sent while Codex was busy has now been delivered — Codex is starting a turn on it.",
      ),
    );
    return;
  }

  if (codex.turnInProgress) {
    // A new turn started between the completion event and this call.
    // Keep the original queuedAt so the TTL still measures Claude's wait.
    replyOutbox.requeue(reply);
    log(`Queued reply ${reply.id} still blocked by an in-progress turn; keeping it`);
    return;
  }

  log(`Queued reply ${reply.id} could not be injected (no active thread); dropping`);
  emitToFrontends(
    noticeMessage(
      "reply_undeliverable",
      "⚠️ A reply you sent while Codex was busy could not be delivered — the Codex thread is gone. " +
        `Reconnect the Codex TUI and send it again.\n\nUndelivered message:\n${truncateForNotice(reply.content)}`,
    ),
  );
  // Anything still held is blocked on the same dead thread.
  discardOutboxForLostCodex("the Codex thread is gone");
}

/**
 * Drop everything held for Codex and tell Claude what was lost.
 *
 * Called when the Codex side goes away. A message written for a thread
 * that no longer exists would land in a fresh conversation with no
 * context, which reads to Codex as a non-sequitur — worse than saying
 * plainly that it never arrived.
 */
function discardOutboxForLostCodex(why: string): void {
  const lost = replyOutbox.clear();
  if (lost.length === 0) return;
  log(`Discarding ${lost.length} queued Claude → Codex repl(ies): ${why}`);
  emitToFrontends(
    noticeMessage(
      "reply_discarded",
      `⚠️ ${lost.length} repl${lost.length > 1 ? "ies" : "y"} you sent while Codex was busy ` +
        `${lost.length > 1 ? "were" : "was"} never delivered — ${why}. ` +
        `Resend if still relevant.\n\n` +
        lost.map((r, i) => `[${i + 1}] ${truncateForNotice(r.content)}`).join("\n\n"),
    ),
  );
}

/** Keep a lost-message echo readable without replaying a whole essay. */
function truncateForNotice(content: string, max = 400): string {
  return content.length <= max ? content : `${content.slice(0, max)}… (${content.length} chars total)`;
}

/**
 * Give `agent`'s slot to `ws`, contesting the incumbent if there is one.
 *
 * Contention is per-agent: a Grok frontend arriving while Claude holds
 * its slot is not a contest at all, it is a second tenant. Only another
 * frontend claiming the *same* identity has to win a liveness probe.
 */
async function attachFrontend(ws: ServerWebSocket<ControlSocketData>, agent: FrontendAgent) {
  const label = `${agent} frontend`;
  const occupant = frontends.contestedBy(agent, ws);
  if (occupant) {
    // Slot is occupied by another socket that hasn't yet shown us FIN.
    // Issue #68: OS may never surface a FIN for a crashed peer, so readyState
    // stays OPEN forever. Probe the incumbent with a ping before rejecting.
    const msSincePong = Date.now() - occupant.data.lastPongAt;
    log(
      `${label} contest: new=#${ws.data.clientId}, incumbent=#${occupant.data.clientId} ` +
      `(readyState=${occupant.readyState}, msSincePong=${msSincePong})`,
    );

    if (frontends.isProbing(agent)) {
      log(
        `Rejecting ${label} #${ws.data.clientId} — another liveness probe already in flight`,
      );
      ws.close(
        CLOSE_CODE_PROBE_IN_PROGRESS,
        "liveness probe in progress, retry shortly",
      );
      return;
    }

    frontends.beginProbe(agent);
    let incumbentAlive = false;
    try {
      incumbentAlive = await probeLiveness(occupant, LIVENESS_PROBE_TIMEOUT_MS);
    } finally {
      frontends.endProbe(agent);
    }

    // Slot may have cleared during the probe (real close fired, or the new ws
    // left). Re-read state before committing a decision.
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      log(`Contestant #${ws.data.clientId} disappeared during probe — aborting`);
      if (!incumbentAlive) {
        evictStale(occupant, "contestant gone but probe still failed");
      }
      return;
    }

    if (incumbentAlive) {
      log(
        `Rejecting ${label} #${ws.data.clientId} — incumbent #${occupant.data.clientId} responded to liveness probe`,
      );
      ws.close(CLOSE_CODE_REPLACED, `another ${agent} session is already connected`);
      return;
    }

    evictStale(occupant, `liveness probe timed out after ${LIVENESS_PROBE_TIMEOUT_MS}ms`);
    // Fall through to accept path below.
  }

  const raced = frontends.contestedBy(agent, ws);
  if (raced) {
    // Another contestant may have raced in between the probe and here. Reject.
    log(
      `Rejecting ${label} #${ws.data.clientId} — slot re-acquired by #${raced.data.clientId} after probe`,
    );
    ws.close(CLOSE_CODE_REPLACED, `another ${agent} session is already connected`);
    return;
  }

  if (agent === DEFAULT_FRONTEND_AGENT) {
    clearPendingClaudeDisconnect("Claude frontend attached");
  }
  frontends.claim(agent, ws);
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`${label} attached (#${ws.data.clientId})`);

  statusBuffer.flush(`${agent} reconnected`);
  sendStatus(ws);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  if (frontends.bufferedCount(agent) > 0) {
    flushBufferedMessages(agent, ws);
  } else if (!isRapidReattach) {
    // Only send status messages if this is not a rapid reattach (avoid flooding Claude)
    if (tuiConnectionState.canReply()) {
      sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessage()));
    } else if (codexBootstrapped) {
      sendBridgeMessage(ws, systemMessage("system_waiting", currentWaitingMessage()));
    }
  }

  lastAttachStatusSentTs = now;

  // Codex-facing notices stay keyed to Claude on purpose. Every one of
  // them names Claude to Codex, and Codex's own role text was written
  // about Claude; announcing a second agent under that copy would be a
  // product decision, not bookkeeping.
  if (agent === DEFAULT_FRONTEND_AGENT && tuiConnectionState.canReply() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
}

/**
 * Release whichever slot `ws` holds.
 *
 * No-op for a socket that holds none — including one already superseded
 * by a replacement, which must not be able to evict its successor by
 * closing late.
 */
function detachFrontend(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  const agent = frontends.releaseSocket(ws);
  if (agent === null) return;

  ws.data.attached = false;
  log(`${agent} frontend detached (#${ws.data.clientId}, ${reason})`);

  if (agent === DEFAULT_FRONTEND_AGENT) {
    scheduleClaudeDisconnectNotification(ws.data.clientId);
  }

  scheduleIdleShutdown();
}

async function probeLiveness(
  ws: ServerWebSocket<ControlSocketData>,
  timeoutMs: number,
): Promise<boolean> {
  return probeLivenessImpl(
    {
      get readyState() { return ws.readyState; },
      get pongCount() { return ws.data.pongCount; },
      ping: () => { ws.ping(); },
    },
    { timeoutMs, pollMs: LIVENESS_PROBE_POLL_MS },
  );
}

/**
 * Evict the incumbent Claude frontend so a newer session can take over.
 * Sends CLOSE_CODE_EVICTED_STALE (4002) and releases the slot so the next
 * attachClaude call can accept a contestant.
 *
 * detachClaude arms a 5s grace timer that pings Codex with "Claude went
 * offline" if nobody re-attaches in that window. For the *handoff* eviction
 * path (a new frontend is about to attach in the same JS task), attachClaude
 * cancels that timer at the "Claude frontend attached" step before any
 * 5s window can elapse. For the *cleanup* eviction path (no replacement —
 * contestant disappeared mid-probe), letting the timer fire is the correct
 * behavior: Codex genuinely has no Claude attached.
 */
function evictStale(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  log(`Evicting stale ${ws.data.agent} frontend #${ws.data.clientId}: ${reason}`);
  detachFrontend(ws, `evicted: ${reason}`);
  try {
    ws.close(CLOSE_CODE_EVICTED_STALE, "stale frontend evicted by newer session");
  } catch (err: any) {
    log(`Evict close threw on #${ws.data.clientId}: ${err.message}`);
  }
}

function startAttentionWindow() {
  clearAttentionWindow();
  inAttentionWindow = true;
  statusBuffer.pause();
  log(`Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  attentionWindowTimer = setTimeout(() => {
    attentionWindowTimer = null;
    inAttentionWindow = false;
    statusBuffer.resume();
    log("Attention window ended");
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow() {
  if (attentionWindowTimer) {
    clearTimeout(attentionWindowTimer);
    attentionWindowTimer = null;
  }
  if (inAttentionWindow) {
    statusBuffer.resume();
  }
  inAttentionWindow = false;
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (frontends.size > 0) return; // still has a client

  const snapshot = tuiConnectionState.snapshot();
  if (snapshot.tuiConnected) return; // TUI still connected

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    // Re-check before shutting down
    if (frontends.size > 0 || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function clearPendingClaudeDisconnect(reason?: string) {
  if (!claudeDisconnectTimer) return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}

function scheduleClaudeDisconnectNotification(clientId: number) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;

    if (claudeSocket()) {
      log(
        `Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`,
      );
      return;
    }

    if (!tuiConnectionState.canReply()) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Codex cannot reply`,
      );
      return;
    }

    if (!claudeOnlineNoticeSent) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Claude was never announced online`,
      );
      return;
    }

    codex.injectMessage(
      "⚠️ Claude Code went offline. AgentBridge is still running in the background; it will reconnect automatically when Claude reopens.",
    );
    claudeOnlineNoticeSent = false;
    claudeOfflineNoticeShown = true;
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

/**
 * Deliver a message to every frontend except the one that wrote it.
 *
 * Each agent that misses it — not attached, or a send that failed —
 * keeps its own buffer, so a Grok session that never launched cannot
 * make Claude's reconnect replay Grok's backlog, and neither one's
 * overflow discards the other's messages.
 */
function emitToFrontends(message: BridgeMessage, deliveryHint?: "push" | "queue") {
  const delivered = new Set<FrontendAgent>();
  for (const { agent, socket } of frontends.recipients(message.source)) {
    if (trySendBridgeMessage(socket, message, deliveryHint)) {
      delivered.add(agent);
      continue;
    }
    // Send failed — fall through to buffer
    log(`Send to ${agent} failed, buffering message for retry on reconnect`);
  }

  // Buffered messages preserve their delivery hint via an attached
  // property; flushBufferedMessages reads it back when replaying. We
  // store the hint inline on the BridgeMessage at runtime (kept off
  // the type definition because it is a daemon-internal artifact).
  if (deliveryHint) {
    (message as BridgeMessage & { __deliveryHint?: "push" | "queue" }).__deliveryHint = deliveryHint;
  }

  for (const agent of frontends.knownAgents()) {
    if (delivered.has(agent) || agent === message.source) continue;
    const { dropped } = frontends.buffer(agent, message);
    if (dropped > 0) {
      log(`Message buffer overflow for ${agent}: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
    }
  }
}

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage, deliveryHint?: "push" | "queue"): boolean {
  try {
    const payload: ControlServerMessage = deliveryHint
      ? { type: "codex_to_claude", message, deliveryHint }
      : { type: "codex_to_claude", message };
    const result = ws.send(JSON.stringify(payload));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(agent: FrontendAgent, ws: ServerWebSocket<ControlSocketData>) {
  const messages = frontends.takeBuffered(agent);
  for (const message of messages) {
    // Recover the delivery hint we stashed on the message when it
    // was buffered, so a queued message stays queued after replay.
    const hint = (message as BridgeMessage & { __deliveryHint?: "push" | "queue" }).__deliveryHint;
    if (!trySendBridgeMessage(ws, message, hint)) {
      // Re-buffer this and all remaining messages on failure
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      frontends.requeue(agent, remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage) {
  trySendBridgeMessage(ws, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  for (const { socket } of frontends.recipients()) {
    sendStatus(socket);
  }
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: frontends.bufferedCount() + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
    claudeAttached: frontends.isAttached(DEFAULT_FRONTEND_AGENT),
    attachedAgents: frontends.attachedAgents(),
    pendingReplyCount: replyOutbox.size,
    projectId: DAEMON_PROJECT_ID,
  };
}

function currentWaitingMessage() {
  return `⏳ Waiting for Codex TUI to connect. Run in another terminal:\n${attachCmd}`;
}

function currentReadyMessage() {
  return `✅ Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
}

function notifyCodexClaudeOnline(): boolean {
  const message = !codexCollaborationKickoffSent
    ? [
        "🤝 Claude Code has connected via AgentBridge.",
        "You are now in a multi-agent collaboration session.",
        "When you receive a complex task, propose a division of labor to Claude.",
        "Claude can send you messages — they will appear as injected user messages.",
        "Respond naturally and Claude will receive your output via AgentBridge.",
      ].join("\n")
    : "✅ AgentBridge connected to Claude Code.";

  const delivered = codex.injectMessage(message);
  if (!delivered) {
    log("Deferred Claude-online notice to Codex — will retry after current turn completes");
    return false;
  }

  claudeOnlineNoticeSent = true;
  claudeOfflineNoticeShown = false;
  codexCollaborationKickoffSent = true;
  return true;
}

function shouldNotifyCodexClaudeOnline() {
  return !claudeOnlineNoticeSent || claudeOfflineNoticeShown;
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

/**
 * A daemon-authored message that must reach Claude as *content*.
 *
 * `systemMessage` ids are deliberately swallowed by the frontend: any
 * `system_*` prefix is converted to a statusbar tag and never enters
 * Claude's context, which is what keeps a newly added lifecycle event
 * from leaking into the chat. The outbox notices are the opposite case
 * — they carry the text of a message that was delayed or lost, so a
 * statusbar tag would destroy the only copy. The `notice_` prefix opts
 * out of that routing.
 */
function noticeMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `notice_${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content: `[AgentBridge] ${content}`,
    timestamp: Date.now(),
  };
}

function writePidFile() {
  daemonLifecycle.writePid();
}

function removePidFile() {
  daemonLifecycle.removePidFile();
}

function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });
}

function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}

async function bootCodex() {
  log("Starting AgentBridge daemon...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);

  try {
    await codex.start();
    codexBootstrapped = true;
    writeStatusFile();

    emitToFrontends(systemMessage("system_waiting", currentWaitingMessage()));
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start Codex: ${err.message}`);
    emitToFrontends(
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start Codex app-server: ${err.message}`,
      ),
    );
    broadcastStatus();
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  // Write the final state to status.line BEFORE tearing down the
  // control server. If the bridge dies with us (Claude Code quit),
  // it cannot emit [BRIDGE OFFLINE] on its own, and the user would
  // be left looking at a stale [CODEX READY] / [CODEX THINKING] tag
  // until the next session.
  daemonStatusLine.write(BRIDGE_STOPPED_TAG);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
/**
 * Flipped once the daemon is serving. Before that point an uncaught
 * exception means the daemon never came up, and staying alive to log
 * about it is worse than dying: the process lingers with no control
 * server, `wait` reports exit 0, and every caller reads that as
 * "started fine". After that point a stray exception is not a reason
 * to drop a live Codex session, so it stays a log line.
 */
let startupComplete = false;

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
  if (!startupComplete) {
    log("Exception happened during startup — the daemon never came up. Exiting 1.");
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}\n`;
  process.stderr.write(line);
  getRotatingLogger(stateDir.logFile).write(line);
}

// Refuse to start if user intentionally killed the daemon.
// This prevents stale auto-reconnect loops from relaunching us.
// Only `agentbridge codex` / `ensureRunning` clears the sentinel before launching.
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}

// Ask who holds the control port before binding it. `Bun.serve` throws
// "Failed to start server. Is port N in use?", which names neither the
// holder nor the fix — and in the collision this actually guards
// against, the adapter's clear message sits further down a path we
// would never reach.
const controlPortHolder = await probeControlPort(CONTROL_PORT);
if (controlPortHolder.kind !== "free") {
  const detail = describeControlPortConflict(CONTROL_PORT, DAEMON_PROJECT_ID, controlPortHolder);
  for (const line of detail.split("\n")) log(line);
  process.exit(1);
}

writePidFile();
try {
  startControlServer();
} catch (err: any) {
  // Lost a race between the probe and the bind, or the port is
  // unbindable for a reason the probe cannot see.
  log(`Failed to start the control server on port ${CONTROL_PORT}: ${err?.message ?? err}`);
  removePidFile();
  process.exit(1);
}
startupComplete = true;
void bootCodex();
