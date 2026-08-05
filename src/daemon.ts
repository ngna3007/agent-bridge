#!/usr/bin/env bun

import type { ServerWebSocket } from "bun";
import { CodexAdapter } from "./codex-adapter";
import type { CodexProseIngress, InjectionRejection } from "./codex-adapter";
import { GrokAdapter } from "./grok-adapter";
import type {
  GrokInjectionCorrelation,
  GrokInjectionDelivery,
  GrokInjectionRejection,
  GrokProseIngress,
} from "./grok-adapter";
import { getRotatingLogger } from "./log-rotator";
import { StatusLineWriter } from "./status-line-writer";
import { BRIDGE_STOPPED_TAG } from "./lifecycle-tags";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
  type FilterResult,
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
  CLOSE_CODE_UNKNOWN_AGENT,
} from "./control-protocol";
import { probeControlPort, describeControlPortConflict } from "./port-preflight";
import { parsePositiveIntEnv } from "./env-utils";
import { ReplyOutbox } from "./reply-outbox";
import type {
  ControlClientMessage,
  ControlServerMessage,
  DaemonStatus,
} from "./control-protocol";
import type { AgentId, BridgeMessage } from "./types";
import { forEgress } from "./daemon-egress";
import { probeLiveness as probeLivenessImpl } from "./liveness-probe";
import {
  DEFAULT_FRONTEND_AGENT,
  FRONTEND_AGENTS,
  FrontendRegistry,
  parseFrontendAgent,
} from "./frontend-registry";
import type { FrontendAgent } from "./frontend-registry";
import { agentLabel, isAgentId } from "./agent-id";
import { Mailbox } from "./mailbox";
import { MessageIndex } from "./message-index";
import { MessageBus } from "./message-bus";
import { PendingRequests } from "./pending-requests";
import { ReplyObligations } from "./reply-obligations";
import { grokWakeTransport } from "./grok-wake";
import { TransportRegistry, type WakeupTransport } from "./wakeup-transport";
import {
  deliveryHintFor,
  registerTransport as registerTransportIn,
  routeThroughBus as routeThroughBusIn,
  senderFacingText,
  type RouteOutcome,
} from "./daemon-bus";
import { PROTOCOL_VERSION, normalizeIngress, normalizeProse } from "./normalize-ingress";
import {
  INDEX_CAPACITY,
  INDEX_TTL_MS,
  LEASE_TIMEOUT_MS,
  MAILBOX_CAPACITY,
} from "./daemon-constants";

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
  /**
   * The envelope shape this frontend declared in `claude_connect`.
   *
   * `null` means it declared none — a pre-0.8 frontend, whose payload
   * `source` field was never authenticated and is therefore ignored
   * rather than treated as a mismatch. Absent is tolerated, not refused.
   */
  protocolVersion: number | null;
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
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
const ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

const codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

/**
 * Grok's proxy, in the same role the Codex proxy plays.
 *
 * Constructed unconditionally and cheaply: `start` only opens a unix
 * socket, and the socket has to exist before `abg grok` has anything to
 * point a TUI at. No Grok installed and no TUI launched costs one idle
 * listener.
 */
const grok = new GrokAdapter({
  socketPath: stateDir.grokLeaderSocket,
  logFile: stateDir.logFile,
});

/**
 * Whether a Grok TUI has ever been through this proxy.
 *
 * Gates Grok's membership in `knownAgents` the way attaching gates a
 * frontend's: broadcasting to a Grok that has never connected fills a
 * mailbox nobody will drain. "Ever", not "now", for the same reason the
 * frontend registry keeps known separate from attached — a TUI being
 * restarted must keep receiving into its mailbox.
 */
let grokEverAttached = false;

let controlServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * One frontend slot per agent identity.
 *
 * Was a single `attachedClaude` variable until Grok Build turned out to
 * load Claude Code's plugin registry, launch this same MCP server, and
 * land in Claude's slot — see `src/frontend-registry.ts` and
 * `docs/scaling-plan.md` §4.1b.
 */
const frontends = new FrontendRegistry<ServerWebSocket<ControlSocketData>>({
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
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRequestsTimer: ReturnType<typeof setInterval> | null = null;
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

/**
 * Requests waiting on a reply, correlated per-request rather than by one
 * module-level flag. See `src/pending-requests.ts` for why: with
 * addressing, a `[REPLY @grok]` must not clear a request Claude is still
 * waiting on.
 */
const pendingRequests = new PendingRequests();

/**
 * How long a require-reply request may sit unanswered before it is
 * reported as missing. Same order of magnitude as the reply outbox TTL
 * above — both bound how long a sender's request may go unaddressed
 * before AgentBridge says so instead of staying quiet.
 */
const PENDING_REQUEST_TTL_MS = parsePositiveIntEnv("AGENTBRIDGE_REPLY_REQUIRED_TTL_MS", 10 * 60_000, log);
/** How often `checkExpiredRequests` sweeps for requests past their TTL. */
const PENDING_REQUEST_CHECK_INTERVAL_MS = 30_000;

// ===========================================================================
// The message bus.
//
// Every recipient owns a mailbox held by the daemon, and the mailbox —
// not a wake-up — is the system of record. A wake-up that returns
// success is not evidence the payload reached the model
// (`docs/channels-silent-block.md`), so nothing is deleted from a
// mailbox until the consumer acks it. This replaces the per-frontend
// buffers that used to live in `FrontendRegistry`, where a message held
// for an agent could only ever be replayed by the daemon guessing when
// to replay it.
// ===========================================================================

const mailboxes = new Map<AgentId, Mailbox>();

/** Every agent has a mailbox, attached or not. That is the point of having one. */
function mailboxFor(agent: AgentId): Mailbox {
  let box = mailboxes.get(agent);
  if (!box) {
    box = new Mailbox(agent, { capacity: MAILBOX_CAPACITY, leaseTimeoutMs: LEASE_TIMEOUT_MS });
    mailboxes.set(agent, box);
  }
  return box;
}

const messageIndex = new MessageIndex({ capacity: INDEX_CAPACITY, ttlMs: INDEX_TTL_MS });
const transports = new TransportRegistry();

/** The agent whose request opened each agent's current turn. Turn-scoped. */
const activeRequester = new Map<AgentId, AgentId>();

const bus = new MessageBus({
  mailboxFor,
  index: messageIndex,
  state: {
    // Broadcast means everyone who is actually here. An agent that has
    // never connected is not a recipient: fanning out to it fills a
    // mailbox nobody will ever drain, and the first hundred messages
    // later come back as "grok's mailbox is full" on sends that worked
    // perfectly — which trains the user to ignore the shed note that
    // partial-rejection reporting depends on being read.
    //
    // Codex is unconditional because it has no control socket to attach
    // with; its presence is the app-server process, not a slot.
    //
    // "Known", not "attached": a frontend that has attached once and is
    // mid-reconnect must keep receiving into its mailbox, which is the
    // entire reason the mailbox exists. `FrontendRegistry.knownAgents`
    // seeds Claude, so a message that arrives before Claude's first
    // connect is still retained — long-standing behaviour.
    knownAgents: () =>
      ["codex", ...(grokEverAttached ? (["grok"] as const) : []), ...frontends.knownAgents()],
    senderOf: (id, replier, now) => messageIndex.resolveSender(id, replier, now),
    activeRequesterFor: (agent) => activeRequester.get(agent) ?? null,
  },
  transports,
  log,
});

let idSeq = 0;
function nextMessageId(): string {
  return `msg_${Date.now()}_${++idSeq}`;
}

/**
 * Who is still owed a reply. See `src/reply-obligations.ts` for why this
 * is one object and not a flag each path clears for itself.
 */
const obligations = new ReplyObligations();

/** Sender-facing text produced while waking Codex, read back by the send that caused it. */
const codexDeferralNotes = new Map<string, string>();

/** Who was waiting on each reply the outbox is holding. */
const outboxRequester = new Map<string, AgentId>();

/**
 * Codex's wake-up: inject the message as a turn.
 *
 * This is where `deliverToCodex` is demoted from "the delivery" to "one
 * transport's wake-up". A refusal is a deferral, not a loss — the outbox
 * holds the content and re-injects when the current turn ends.
 *
 * Note what the deferral costs: this wake returns normally, so the
 * `registerTransport` self-ack below deletes the mailbox entry even
 * though Codex has not seen the message. On the deferred path the
 * **outbox**, not the mailbox, is the system of record. That is why the
 * outbox has to report every way it can drop an entry — cap-drop on
 * accept, expiry and undeliverable in `drainReplyOutbox`, discard in
 * `discardOutboxForLostCodex` — each echoing the text back to the
 * sender. Those reports are what keep a deferral from becoming a silent
 * loss once the mailbox copy is gone.
 */
/**
 * Register a transport, self-acking it when it can never ack for itself.
 * See `registerTransport` in `src/daemon-bus.ts` for why.
 */
function registerTransport(agent: AgentId, transport: WakeupTransport): void {
  registerTransportIn({ transports, mailboxFor }, agent, transport);
}

registerTransport("codex", {
  payloadMode: "content",
  acknowledgementMode: "none",
  wake: (message) => {
    const requireReply = obligations.discharge(message.id);
    const requester = isAgentId(message.from) ? message.from : null;

    if (deliverToCodex(message.content, requireReply, requester, message.id)) {
      // The sender has answered, so the attention window opened for it is over.
      clearAttentionWindow();
      return;
    }

    const { depth, dropped } = replyOutbox.accept({
      id: message.id,
      content: message.content,
      requireReply,
      queuedAt: Date.now(),
    });
    if (requester) outboxRequester.set(message.id, requester);
    log(`Queued reply for Codex while it was busy (depth ${depth}, dropped ${dropped.length})`);

    // `turnPending`, not `turnInProgress`: a turn/start already on the
    // wire is a turn from the sender's point of view, and telling them
    // "no thread" for it would be wrong in the one direction that
    // matters — it reads as "gone", not as "held".
    let note = codex.turnPending
      ? depth > 1
        ? `Codex is mid-turn. Held for delivery when the turn ends (${depth} replies now queued, sent in order).`
        : "Codex is mid-turn. Held for delivery when the turn ends."
      : "Codex has no thread to inject into right now. Held for delivery when one is available.";
    if (dropped.length > 0) {
      note +=
        ` ${dropped.length} older queued repl${dropped.length > 1 ? "ies were" : "y was"}` +
        ` dropped to stay under the ${replyOutbox.capacity}-message limit.`;
    }
    codexDeferralNotes.set(message.id, note);
  },
});

registerTransport(
  "grok",
  grokWakeTransport({
    obligations,
    inject: (content, correlation) => grok.injectMessage(content, correlation),
    expectReply: (requester, messageId) =>
      pendingRequests.add({ requester, responder: "grok", messageId, at: Date.now() }),
    log,
  }),
);

/**
 * Deliver what piled up while no Grok TUI was connected.
 *
 * Grok has no `get_messages`: it cannot pull its own mailbox the way a
 * frontend does, so nothing would ever drain this on its own. Messages
 * addressed to a Grok that was not running are held rather than shed —
 * the mailbox is the whole point — and this is the only thing that
 * hands them over.
 */
function drainGrokBacklog(why: string): void {
  const batch = mailboxFor("grok").drain(Date.now());
  if (batch.messages.length === 0) return;
  log(`Delivering ${batch.messages.length} held message(s) to Grok (${why})`);
  for (const message of batch.messages) {
    void transports.wake("grok", message, log);
  }
}

/**
 * A frontend's wake-up: push the message down its control socket.
 *
 * `payloadMode: "content"` describes the frame, not the outcome — a
 * `codex_to_claude` that leaves this process may still never reach the
 * model, which is why the mailbox keeps its copy until an ack. Throwing
 * is how a transport reports failure: `TransportRegistry.wake` turns it
 * into a logged `"failed"` and the message waits.
 */
function frontendTransport(agent: FrontendAgent): WakeupTransport {
  return {
    payloadMode: "content",
    // A frontend *can* produce correlated evidence: it drains under a
    // lease and acks by id over its control socket. Nothing deletes on
    // its behalf, which is why the push may be lost without the message
    // being lost.
    acknowledgementMode: "explicit",
    wake: (message) => {
      const socket = frontends.occupant(agent);
      if (socket === null || !frontends.isAttached(agent)) {
        throw new Error(`${agent} is not attached`);
      }
      if (!trySendBridgeMessage(socket, message, deliveryHintFor(message, FILTER_MODE))) {
        throw new Error(`the control socket for ${agent} refused the frame`);
      }
    },
  };
}

for (const agent of FRONTEND_AGENTS) registerTransport(agent, frontendTransport(agent));

/** The one call into the bus. See `routeThroughBus` in `src/daemon-bus.ts`. */
async function routeThroughBus(
  envelope: BridgeMessage,
  opts: { requireReply?: boolean } = {},
): Promise<RouteOutcome> {
  return routeThroughBusIn({ bus, log }, envelope, opts);
}

/**
 * Fire-and-forget send for a path with no sender waiting on a result.
 *
 * The daemon is the sender here, so the log *is* the sender-facing
 * surface. It still has to be told — an outcome that reaches nobody at
 * all is the failure mode this union exists to make impossible.
 */
function routeOrLog(envelope: BridgeMessage): void {
  void routeThroughBus(envelope).then((outcome) => {
    const text = senderFacingText(outcome);
    if (text !== null) log(`Daemon-authored ${envelope.id}: ${text}`);
  });
}

/**
 * Fan a daemon-authored notice out to the frontends, one envelope each.
 *
 * `to: null` from `system` is a broadcast to every *known* agent, and
 * that set includes Codex — so a notice like "Codex is working on the
 * current task" would be injected back into Codex's own turn. These
 * notices are observations about the bridge addressed to the agents
 * watching it, so each frontend is addressed explicitly and the routing
 * decision stays inside `resolveRecipients`.
 */
function emitToFrontends(build: (to: AgentId) => BridgeMessage): void {
  for (const agent of frontends.knownAgents()) routeOrLog(build(agent));
}

/**
 * Fan a lifecycle notice out to the frontends *without* a mailbox.
 *
 * `system_*` notices are statusbar tags — "Codex is working", "turn
 * completed", "TUI reconnected". They carry no reply semantics, nobody
 * can act on a stale one, and each is superseded by the next within
 * seconds. Giving them at-least-once storage was actively harmful: two
 * per Codex turn is enough to pin a 100-slot mailbox permanently, after
 * which every real `[REPLY]` is shed against a backlog of notices about
 * turns that ended an hour ago.
 *
 * So they are wake-only: delivered if the agent is here to receive them,
 * dropped if it is not. That is the correct semantic for a tag, and it
 * is not silent shedding of *messages* — nothing addressed by one agent
 * to another takes this path. Everything with content a sender could be
 * waiting on still goes through `emitToFrontends` and the bus.
 */
function notifyFrontends(build: (to: AgentId) => BridgeMessage): void {
  for (const agent of frontends.attachedAgents()) {
    void transports.wake(agent, build(agent), log);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    notifyFrontends((to) =>
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
        to,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    notifyFrontends((to) =>
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`,
        to,
      ),
    );
    codex.injectMessage("✅ Claude Code is still online, bridge restored. Bidirectional communication can continue.");
  },
});

// Route the periodic [STATUS] summary to Claude's pull queue
// instead of pushing it on the MCP channel. Same reasoning as
// untagged Codex output: routine progress should not auto-bloat
// Claude's context. Claude can drain via get_messages if curious.
const statusBuffer = new StatusBuffer((summary) =>
  emitToFrontends((to) => ({
    ...summary,
    // The summary is built by message-filter with its own id; re-id it
    // per copy so two flushes inside the same millisecond cannot collide
    // in the provenance index, which rejects a duplicate id.
    id: `status_summary_${++nextSystemMessageId}`,
    to,
  })),
);

codex.on("turnStarted", () => {
  log("Codex turn started");
  notifyFrontends((to) =>
    systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
      to,
    ),
  );
});

/**
 * Notices for Codex that arrived while one of its turns was still open.
 *
 * `agentMessage` is emitted from `item/completed`, which fires *inside*
 * the turn — `turnInProgress` is not cleared until `turn/completed`. So
 * every notice produced while handling a Codex message is injected into
 * a busy adapter and refused. Discarding the refusal would leave Codex
 * unable to learn the one thing only the daemon knows: that the name it
 * addressed does not resolve, or that its `[REPLY]` reached one
 * recipient and was shed by another.
 *
 * These are not queued replies. The reply outbox carries a mailbox id, a
 * `requireReply` flag and a requester, and reports its own losses to
 * *frontends* as "a reply you sent" — a daemon notice routed through it
 * would be echoed back to the user as their own message. So notices get
 * their own deferral, flushed by the `turnCompleted` handler alongside
 * the Claude-online notice that already works this way.
 */
const pendingCodexNotices: string[] = [];
let droppedCodexNotices = 0;

/** Bounds the queue in a process that runs for days. Overflow is reported, not hidden. */
const PENDING_CODEX_NOTICE_CAP = 20;

/**
 * Tell Codex something it cannot otherwise learn, now or when it is free.
 *
 * Never silent: delivered immediately, or held and flushed at the end of
 * the current turn, or — if the queue overflows — counted and reported
 * in the flush.
 */
function tellCodex(text: string): void {
  const framed = `[AgentBridge] ${text}`;
  if (codex.injectMessage(framed)) return;
  pendingCodexNotices.push(framed);
  while (pendingCodexNotices.length > PENDING_CODEX_NOTICE_CAP) {
    pendingCodexNotices.shift();
    droppedCodexNotices++;
  }
  log(`Deferred an AgentBridge notice to Codex (${pendingCodexNotices.length} pending)`);
}

/**
 * Flush every held notice as one injection.
 *
 * One injection, not one per notice: the first would start a turn and
 * every later one would be refused, so they would trickle out a turn at
 * a time. On failure nothing is consumed and the next completed turn
 * tries again.
 */
function flushPendingCodexNotices(): void {
  if (pendingCodexNotices.length === 0) return;
  const parts = [...pendingCodexNotices];
  if (droppedCodexNotices > 0) {
    parts.unshift(
      `[AgentBridge] ${droppedCodexNotices} earlier notice${droppedCodexNotices > 1 ? "s were" : " was"}` +
        ` dropped to stay under the ${PENDING_CODEX_NOTICE_CAP}-notice limit.`,
    );
  }
  if (!codex.injectMessage(parts.join("\n\n"))) {
    log(`Could not flush ${pendingCodexNotices.length} held AgentBridge notice(s); keeping them`);
    return;
  }
  log(`Flushed ${pendingCodexNotices.length} held AgentBridge notice(s) to Codex`);
  pendingCodexNotices.length = 0;
  droppedCodexNotices = 0;
}

/**
 * One proxied agent's prose, on its way to the bus.
 *
 * Codex and Grok reach the daemon by different roads and arrive in the
 * same place. `respondingTo` is the only asymmetry, and it is an
 * asymmetry of evidence rather than of policy: Grok's adapter can say
 * which injected prompt a turn answers, Codex's cannot.
 */
interface ProxiedIngress {
  agent: Extract<AgentId, "codex" | "grok">;
  senderRef: string;
  content: string;
  /** The injected prompt this turn answers, when the adapter knows. */
  respondingTo: GrokInjectionCorrelation | null;
  /** How the daemon speaks back to this agent, as the bridge. */
  tell: (text: string) => void;
}

/**
 * The ingress path every proxied agent takes: classify, normalise, route.
 *
 * Deliberately one function rather than one per agent. What happens to a
 * message between "the adapter saw prose" and "the bus has it" is
 * production-defining — which marker buffers, when the status buffer
 * flushes, what closes a `require_reply`, when the attention window
 * opens — and two copies of it drift. They already had: the attention
 * window suppressed Codex's `[STATUS]` and not Grok's, for no reason
 * anyone chose.
 */
async function handleProxiedMessage(msg: ProxiedIngress): Promise<void> {
  const { agent, tell } = msg;
  const label = agentLabel(agent);

  // Turn ownership arrives with the turn, not with the injection that
  // asked for it — see the `registerTransport("grok")` wake for why. It
  // has to be set before `routeThroughBus`, which reads it synchronously
  // in `resolveRecipients` to send an untagged reply back to whoever
  // asked instead of broadcasting it.
  if (msg.respondingTo && isAgentId(msg.respondingTo.requester)) {
    activeRequester.set(agent, msg.respondingTo.requester);
  }

  // The adapter hands over prose, not an envelope: attribution on ingress
  // comes from where the message arrived. `normalizeProse` writes `from`
  // accordingly, and is the only thing that constructs a `BridgeMessage`
  // on this path — so it runs before anything downstream (including the
  // status buffer) sees it.
  let result: FilterResult;
  try {
    result = classifyMessage(msg.content, FILTER_MODE);
  } catch (err: unknown) {
    // An unknown @name is a parse failure, not a broadcast. Tell the sender.
    tell(describeError(err));
    return;
  }

  let envelope: BridgeMessage;
  try {
    envelope = normalizeProse(
      msg.content,
      { agent, protocolVersion: PROTOCOL_VERSION },
      { id: nextMessageId(), now: Date.now(), senderRef: msg.senderRef },
    );
  } catch (err: unknown) {
    tell(describeError(err));
    return;
  }

  // During attention window, suppress STATUS to give the recipient space
  // to respond. Skipped in full mode: full mode's contract is "forward
  // everything", and classifyMessage now reports the real marker there,
  // so without this guard a [STATUS] message would start getting
  // buffered instead of forwarded.
  if (FILTER_MODE !== "full" && inAttentionWindow && result.marker === "status") {
    log(`${label} → bus [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(envelope);
    return;
  }

  log(`${label} → bus [${result.marker}/${result.action}] (${msg.content.length} chars)`);

  // [STATUS] still folds into the summary rather than entering a mailbox
  // one message at a time; the summary itself is an ordinary send.
  if (result.action === "buffer") {
    statusBuffer.add(envelope);
    return;
  }

  if (result.marker === "reply" && statusBuffer.size > 0) {
    statusBuffer.flush("reply message arrived");
  }

  const outcome = await routeThroughBus(envelope);
  // Both a refusal and a partial shed are the sender's business: a
  // proxied agent has no other way to learn that the name it addressed
  // does not resolve, or that its `[REPLY]` reached one peer and not
  // another. A partial shed is the dangerous one — the send
  // "succeeded", so nothing else in the system will ever mention it
  // again. This runs inside the sender's own turn, so the injection is
  // deferred; `tell` is what makes it arrive.
  const text = senderFacingText(outcome);
  if (text !== null) tell(text);
  if (outcome.status === "failed") return;

  // Only a [REPLY] satisfies a pending require-reply request — [STATUS] /
  // [FYI] / untagged don't count as "actually replied". Correlated by
  // `inReplyTo` when the agent named it, then by the injection that
  // opened this turn, then by delivery to the requester (an untagged
  // reply back to whoever opened the turn).
  if (result.marker === "reply") {
    pendingRequests.satisfy(
      envelope.inReplyTo ?? msg.respondingTo?.messageId,
      outcome.accepted,
      agent,
    );
    // [REPLY] message — give the recipient an attention window to respond.
    startAttentionWindow();
  }
}

/**
 * Hand prose to the ingress path without letting a throw escape.
 *
 * An async listener hands the emitter a promise it does not await, so a
 * throw anywhere in the handler becomes an unhandled rejection — in a
 * process designed to run for days, on the path every proxied message
 * takes. The emitter gets a sync function; the rejection is caught here.
 */
function receiveProxiedMessage(msg: ProxiedIngress): void {
  void handleProxiedMessage(msg).catch((err: unknown) => {
    log(`${msg.agent} agentMessage handler failed for ${msg.senderRef}: ${describeError(err)}`);
  });
}

codex.on("agentMessage", (msg: CodexProseIngress) => {
  receiveProxiedMessage({
    agent: "codex",
    senderRef: msg.senderRef,
    content: msg.content,
    // The app-server gives no per-turn correlation to read one from.
    respondingTo: null,
    tell: tellCodex,
  });
});

/**
 * Close the turn-scoped state a proxied agent's turn owns.
 *
 * Spec §6 says the requester is discarded at turn end, and a crash is a
 * turn end. When only the clean path cleared it, an app-server that died
 * mid-turn left `activeRequester` set forever: the agent's next
 * spontaneous untagged output hit `routing.ts`'s requester branch and
 * resolved to that one stale agent instead of broadcasting, so every
 * other attached frontend received nothing and nobody was told — silent
 * non-delivery to a live agent, which is exactly what the guarantee
 * forbids. Every path that ends a turn calls this, not just the one that
 * ends it well.
 */
function endAgentTurn(agent: Extract<AgentId, "codex" | "grok">, why: string): void {
  if (!activeRequester.has(agent)) return;
  log(`Clearing ${agentLabel(agent)}'s turn-scoped requester: ${why}`);
  activeRequester.delete(agent);
}

codex.on("turnCompleted", () => {
  log("Codex turn completed");
  statusBuffer.flush("turn completed");

  // Whether a required reply is missing is now decided by
  // `checkExpiredRequests` against each request's own TTL, not by
  // whether this turn happened to end with one still outstanding — a
  // turn ending is not itself evidence of anything; Codex may open
  // another turn on the same requirement moments later.

  endAgentTurn("codex", "the turn completed");

  notifyFrontends((to) =>
    systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
      to,
    ),
  );
  startAttentionWindow();

  // Retry Claude-online notice if it was deferred while the turn was in progress.
  if (claudeSocket() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }

  // Anything the daemon owed Codex about its own last turn — a parse
  // failure, a partial shed. Before the outbox drain because it explains
  // a message Codex has already sent, and because whichever of the two
  // wins the injection slot, the loser keeps its payload and retries at
  // the next completed turn.
  flushPendingCodexNotices();

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

  notifyFrontends((to) => systemMessage("system_ready", currentReadyMessage(), to));

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

// A turn the app-server connection took down with it. No `turn/completed`
// is ever coming for it, so `turnCompleted` never fires and only this
// event closes the turn-scoped state.
codex.on("turnAborted", (why: string) => {
  endAgentTurn("codex", why);
});

/** One proxied agent's backend failing an injection the daemon already reported as sent. */
interface FailedInjection {
  agent: Extract<AgentId, "codex" | "grok">;
  /** The notice kind, which each agent's clients already know by name. */
  kind: string;
  /** What the backend refused: Codex takes a turn, Grok takes a prompt. */
  unit: string;
  /** What refused it, as the notice names it to a human. */
  backend: string;
  /**
   * Whether the backend said no, or the connection simply died with the
   * request already written. These are different facts about the world
   * and the sender has to be able to act on the difference — see
   * `reportFailedInjection`.
   */
  delivery: GrokInjectionDelivery;
  messageId: string;
  /**
   * Whoever sent the message, as an untrusted string off the wire —
   * `null` when the injection carried no sender at all.
   */
  requester: string | null;
  /** The message that did not land, echoed back so the sender can act. */
  text: string;
  reason: string;
}

/**
 * Report an injection that failed after the daemon had acked it.
 *
 * `injectMessage` returning true only means the frame left this process.
 * The failure arrives later, by which time the transport's
 * `acknowledgementMode: "none"` self-ack has deleted the mailbox entry —
 * so without this the message is gone, the agent never saw it, and the
 * only trace is a log line the sender cannot read. That is the exact
 * shape the never-silently-lost guarantee rules out, which is why the
 * notice echoes the text back: a sender told "this did not land" and not
 * shown what it was cannot act on it.
 *
 * Two outcomes, kept apart on purpose. A backend that answers with an
 * error refused the work: nothing ran, and a resend is the right move. A
 * connection that dies with the request already written proves nothing —
 * the turn may have run in full, and telling the sender "it never saw
 * it" invites a resend that runs the same turn's file writes and tool
 * calls a second time. So `unknown` says it is unknown, and the pending
 * reply request stays open: if the turn did run, its reply satisfies it;
 * if it did not, the expiry notice reports that, which is exactly as
 * much as this side knows.
 *
 * Shared rather than written once per agent because every clause here is
 * part of that guarantee, and a guarantee kept in two places is kept in
 * neither.
 */
function reportFailedInjection(failure: FailedInjection): void {
  const { agent, messageId, unit, reason, delivery } = failure;
  const label = agentLabel(agent);
  const verb = delivery === "rejected" ? "refused" : "may not have received";
  log(`${label} ${verb} the ${unit} for ${messageId}: ${reason}`);

  // Whatever this turn owned is out of scope: it either never opened, or
  // it is beyond this side's reach.
  endAgentTurn(agent, `${label} ${verb} the ${unit}`);

  const body =
    delivery === "rejected"
      ? `⚠️ ${label} refused the ${unit} carrying your message — it was not delivered and ${label} never saw it. ` +
        `The ${failure.backend} said: ${reason}`
      : `⚠️ The bridge lost its connection to the ${failure.backend} with your message already sent, so whether ${label} ` +
        `received it is unknown. Do not assume either way: ${label} may answer, or may never have seen it. ` +
        `Resending can make ${label} run the same request twice. The reason given was: ${reason}`;

  if (delivery === "rejected") {
    // A require-reply request against a message the agent never received
    // would otherwise expire into "no reply came" — pointing at the
    // agent instead of at the send that failed. Deliberately not done
    // for `unknown`: there the request is still live, because a reply
    // may still be coming.
    if (pendingRequests.cancel(messageId)) {
      log(`Cancelled the pending reply request for refused message ${messageId}`);
    }
  }

  const echoHeading = delivery === "rejected" ? "Undelivered message" : "The message in question";
  const notice = (to: AgentId) =>
    noticeMessage(
      failure.kind,
      `${body}\n\n${echoHeading}:\n${truncateForNotice(failure.text)}`,
      to,
    );

  const sender = isAgentId(failure.requester) ? failure.requester : null;
  if (sender) routeOrLog(notice(sender));
  else emitToFrontends(notice);
}

codex.on("injectionRejected", ({ correlation, error }: InjectionRejection) => {
  // The contract reminder rode along on the refused turn, so it was
  // never pinned. Let the next injection carry it again.
  lastPinnedContractThreadId = null;

  reportFailedInjection({
    agent: "codex",
    // A `turn/start` error is the app-server declining the work: it
    // answered, so nothing ran.
    delivery: "rejected",
    kind: "turn_start_rejected",
    unit: "turn",
    backend: "app-server",
    messageId: correlation.id,
    requester: correlation.requester,
    text: correlation.text,
    reason: error,
  });
});

codex.on("exit", (code: number | null) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  endAgentTurn("codex", "the Codex app-server exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  // Codex thread is gone; next thread needs the contract pinned again.
  lastPinnedContractThreadId = null;
  discardOutboxForLostCodex("the Codex app-server exited");
  notifyFrontends((to) =>
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`,
      to,
    ),
  );
  broadcastStatus();
});

// ── Grok ────────────────────────────────────────────────────────────

/** Say something to Grok as the bridge. Grok's equivalent of `tellCodex`. */
function tellGrok(text: string): void {
  if (!grok.injectMessage(`[AgentBridge] ${text}`)) {
    log(`Could not tell Grok: ${text}`);
  }
}

grok.on("agentMessage", (msg: GrokProseIngress) => {
  receiveProxiedMessage({
    agent: "grok",
    senderRef: msg.senderRef,
    content: msg.content,
    respondingTo: msg.respondingTo,
    tell: tellGrok,
  });
});

grok.on("sessionAttached", (sessionId: string) => {
  log(`Grok session attached: ${sessionId}`);
  grokEverAttached = true;
  drainGrokBacklog("a Grok session became available");
  broadcastStatus();
});

grok.on("turnCompleted", () => {
  log("Grok turn completed");
  endAgentTurn("grok", "the turn completed");
});

// A Grok TUI counts as a client, so its arrival and departure move the
// idle-shutdown clock the same way a frontend's does — otherwise a
// daemon whose only user is Grok shuts itself down mid-session.
grok.on("tuiConnected", () => {
  log("Grok TUI connected through the proxy");
  cancelIdleShutdown();
  broadcastStatus();
});

grok.on("tuiDisconnected", () => {
  log("Grok TUI disconnected");
  endAgentTurn("grok", "the Grok TUI disconnected");
  scheduleIdleShutdown();
  broadcastStatus();
});

grok.on("injectionRejected", (failure: GrokInjectionRejection) => {
  reportFailedInjection({
    agent: "grok",
    kind: "grok_prompt_rejected",
    unit: "prompt",
    backend: "leader",
    delivery: failure.delivery,
    messageId: failure.messageId,
    requester: failure.requester,
    text: failure.text,
    reason: failure.reason,
  });
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
            protocolVersion: null,
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
            CLOSE_CODE_UNKNOWN_AGENT,
            `Unknown frontend agent ${JSON.stringify(message.agent)} — this daemon serves ${FRONTEND_AGENT_LIST}.`,
          );
          return;
        }
        ws.data.agent = agent;
        // Absent means pre-0.8, which is tolerated rather than refused;
        // `normalizeIngress` decides what a legacy frame may omit.
        ws.data.protocolVersion = message.protocolVersion ?? null;
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
    case "drain": {
      // A socket that never attached holds no slot, so there is no agent
      // whose mailbox it may empty. Answer with an empty batch rather
      // than silence: the caller is waiting on this requestId.
      if (!ws.data.attached) {
        sendProtocolMessage(ws, {
          type: "drain_result",
          requestId: message.requestId,
          // No lease was taken, so no ack can match: a real batch id is
          // always `<agent>_b<n>_<now>`.
          batchId: "",
          messages: [],
        });
        return;
      }
      const batch = mailboxFor(ws.data.agent).drain(Date.now());
      sendProtocolMessage(ws, {
        type: "drain_result",
        requestId: message.requestId,
        batchId: batch.batchId,
        messages: batch.messages.map((m) => forEgress(m, ws.data.protocolVersion)),
      });
      return;
    }
    case "ack": {
      if (!ws.data.attached) return;
      const deleted = mailboxFor(ws.data.agent).ack(message.batchId, message.ids);
      log(`Ack from ${ws.data.agent}: ${deleted}/${message.ids.length} entries deleted`);
      return;
    }
    case "claude_to_codex": {
      // `message.message.source` is deliberately not checked: attribution
      // now comes from the authenticated socket via `normalizeIngress`,
      // so a frontend cannot send as its neighbour regardless of what it
      // writes in the body.
      //
      // `attached` is the authorization predicate `drain` and `ack`
      // already use. A socket that never claimed a slot has no agent
      // identity, so `normalizeIngress` would attribute its message to
      // whatever `DEFAULT_FRONTEND_AGENT` happens to be — Claude.
      if (!ws.data.attached) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "This socket is not attached. Send claude_connect first.",
        });
        return;
      }

      // Deliberately no Codex-readiness gate here. This frame is the
      // only way *any* agent sends anything, and the destination is not
      // known until `resolveRecipients` runs inside the bus — so a gate
      // at this point refused a Claude→Grok message because Codex's TUI
      // had not connected, in a bridge whose claim is that its agents
      // are independent. Codex's readiness is Codex's transport's
      // business: `deliverToCodex` returns false when there is no thread
      // and the outbox holds the message until there is, which is a
      // better answer than a refusal anyway.
      void sendFromFrontend(ws, message.requestId, message.message, !!message.requireReply);
      return;
    }
  }
}

/**
 * A frontend's send, from wire frame to sender-visible result.
 *
 * Everything the sender learns about the fate of this message is decided
 * here: a validation failure, a routing refusal, an overflow rejection,
 * or the note the Codex transport left when it had to defer. Silence is
 * never an acceptable outcome — every path below answers `requestId`.
 */
async function sendFromFrontend(
  ws: ServerWebSocket<ControlSocketData>,
  requestId: string,
  frame: BridgeMessage,
  requireReply: boolean,
): Promise<void> {
  let envelope: BridgeMessage;
  try {
    // Attribution comes from the socket, not the frame. Nothing has been
    // enqueued at this point, so a rejection here leaves no trace.
    envelope = normalizeIngress(
      frame,
      { agent: ws.data.agent, protocolVersion: ws.data.protocolVersion },
      { id: nextMessageId(), now: Date.now() },
    );
  } catch (err: unknown) {
    sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId,
      success: false,
      error: describeError(err),
    });
    return;
  }

  // The other half of the `require_reply` contract; the bus enforces the
  // recipient count. Only `reply` refuses a full mailbox — every other
  // kind sheds under pressure and still reports `accepted`, which would
  // leave an obligation recorded for a message that no longer exists.
  if (requireReply && envelope.kind !== "reply") {
    sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId,
      success: false,
      error: `require_reply is only available on reply-kind messages; ${envelope.id} is ${envelope.kind}. A ${envelope.kind} may be shed when a mailbox fills, which would leave the reply owed by nobody.`,
    });
    return;
  }

  // The wake-up happens inside `bus.route` and cannot take arguments, so
  // the obligation is parked under the daemon-assigned id for whichever
  // transport ends up handing the message over to collect.
  if (requireReply) obligations.require(envelope.id, Date.now());

  const outcome = await routeThroughBus(envelope, { requireReply });

  if (outcome.status === "failed") {
    // Nothing was enqueued, so no transport will ever discharge this.
    // Note what is deliberately *not* here: a discharge on the success
    // path. A wake-up is best-effort — it can fail while the message
    // stays in the mailbox for a later retry — so "the route returned"
    // is not "an agent was handed the message", and clearing here left
    // that retry with no reply instruction and nothing awaiting an
    // answer.
    obligations.release(envelope.id);
    sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId,
      success: false,
      error: outcome.error,
    });
    return;
  }

  // A deferral is an acceptance with an explanation, not a failure — the
  // message is in Codex's mailbox and the outbox will re-wake it. Saying
  // `success: false` here is what used to make callers resend by hand.
  //
  // A partial shed rides along in the same field: both are "accepted,
  // and here is what you need to know about it".
  const deferral = codexDeferralNotes.get(envelope.id);
  codexDeferralNotes.delete(envelope.id);
  const shed = senderFacingText(outcome);
  const note = [deferral, shed].filter((t) => t !== null && t !== undefined).join(" ");

  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId,
    success: true,
    queued: deferral !== undefined ? true : undefined,
    note: note === "" ? undefined : note,
  });
}

/**
 * Decorate a Claude message and inject it as a Codex turn.
 *
 * Every state mutation here happens *after* `injectMessage` returns
 * true. The contract-pin bookkeeping and the pending-request bookkeeping
 * used to be set before the attempt, so a rejected injection left the
 * thread marked as already-pinned (the contract would then never be
 * sent) and armed a pending request against Codex's *current* turn —
 * producing a `reply_missing` warning for a message Codex never
 * received.
 */
function deliverToCodex(
  content: string,
  requireReply: boolean,
  requester: AgentId | null,
  messageId: string,
): boolean {
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
  // The correlation is what turns a later app-server refusal from a log
  // line into something the sender hears about. `content`, not
  // `contentToSend`: the echo should be what the sender wrote, not the
  // contract reminder the daemon stapled to it.
  if (!codex.injectMessage(contentToSend, { id: messageId, requester, text: content })) return false;

  if (needsContract && PIN_CONTRACT_MODE === "once" && activeThreadId) {
    lastPinnedContractThreadId = activeThreadId;
    log(`Pinned BRIDGE_CONTRACT_REMINDER for thread ${activeThreadId.slice(0, 8)}; subsequent msgs skip the reminder`);
  }
  // Only a requester we can name is worth tracking — with nobody to
  // notify on expiry there is nothing `checkExpiredRequests` could do
  // for it anyway. In practice every caller has a requester; this is
  // the same guard `activeRequester` uses below.
  if (requireReply && requester) {
    pendingRequests.add({ requester, responder: "codex", messageId, at: Date.now() });
    log(`Reply required from Codex for ${messageId} (requester: ${requester})`);
  }
  // Codex's turn is now open on this sender's behalf. `resolveRecipients`
  // reads this to let an untagged reply from Codex go back to whoever
  // asked, instead of being broadcast to every agent.
  if (requester) activeRequester.set("codex", requester);
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
    outboxRequester.delete(stale.id);
    emitToFrontends((to) =>
      noticeMessage(
        "reply_expired",
        `⚠️ A reply you sent while Codex was busy waited ~${waitedMin} minutes and was dropped without being delivered. ` +
          `Codex never saw it. Send it again if it still applies.\n\nDropped message:\n${truncateForNotice(stale.content)}`,
        to,
      ),
    );
  }

  if (!reply) return;

  // The sender is carried across the deferral so the turn this delivery
  // opens is still attributed to whoever actually asked.
  if (deliverToCodex(reply.content, reply.requireReply, outboxRequester.get(reply.id) ?? null, reply.id)) {
    outboxRequester.delete(reply.id);
    // Same bookkeeping as a live reply: Claude has answered, so the
    // attention window opened moments ago by turnCompleted is over.
    clearAttentionWindow();
    log(`Delivered queued reply ${reply.id} after turn completion`);
    emitToFrontends((to) =>
      noticeMessage(
        "reply_delivered",
        "📤 The reply you sent while Codex was busy has now been delivered — Codex is starting a turn on it.",
        to,
      ),
    );
    return;
  }

  if (codex.turnPending) {
    // A new turn started — or was started, by the notice flush a few
    // lines earlier in the same tick — between the completion event and
    // this call. `turnPending` covers the in-flight case that
    // `turnInProgress` cannot see yet; without it a deferral here would
    // fall through to the "thread is gone" branch below and discard the
    // whole outbox.
    // Keep the original queuedAt so the TTL still measures Claude's wait.
    replyOutbox.requeue(reply);
    log(`Queued reply ${reply.id} still blocked by an in-progress turn; keeping it`);
    return;
  }

  log(`Queued reply ${reply.id} could not be injected (no active thread); dropping`);
  outboxRequester.delete(reply.id);
  emitToFrontends((to) =>
    noticeMessage(
      "reply_undeliverable",
      "⚠️ A reply you sent while Codex was busy could not be delivered — the Codex thread is gone. " +
        `Reconnect the Codex TUI and send it again.\n\nUndelivered message:\n${truncateForNotice(reply.content)}`,
      to,
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
  for (const r of lost) outboxRequester.delete(r.id);
  emitToFrontends((to) =>
    noticeMessage(
      "reply_discarded",
      `⚠️ ${lost.length} repl${lost.length > 1 ? "ies" : "y"} you sent while Codex was busy ` +
        `${lost.length > 1 ? "were" : "was"} never delivered — ${why}. ` +
        `Resend if still relevant.\n\n` +
        lost.map((r, i) => `[${i + 1}] ${truncateForNotice(r.content)}`).join("\n\n"),
      to,
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

  // First frame on an accepted attach, before anything else: its absence
  // is how a 0.8 frontend detects a daemon too old to drain from.
  sendProtocolMessage(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION });

  statusBuffer.flush(`${agent} reconnected`);
  sendStatus(ws);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  // Nothing is replayed here any more. Whatever arrived while this agent
  // was away is still in its mailbox and leaves only when the frontend
  // drains and acks it; a daemon-side replay would race that lease and
  // deliver the same message twice.
  if (!isRapidReattach) {
    // Only send status messages if this is not a rapid reattach (avoid flooding Claude)
    // Wake-only, like every other `system_*` notice: this describes the
    // state of the bridge at this instant, and the agent is right here.
    if (tuiConnectionState.canReply()) {
      void transports.wake(agent, systemMessage("system_ready", currentReadyMessage(), agent), log);
    } else if (codexBootstrapped) {
      void transports.wake(agent, systemMessage("system_waiting", currentWaitingMessage(), agent), log);
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

/**
 * Sweep for require-reply requests that have sat unanswered past
 * `PENDING_REQUEST_TTL_MS` and report each one — this is the only place
 * `PendingRequests.expire` is called, and the governing rule for the
 * whole bus is that nothing accepted is silently lost, so an expiry
 * that nobody hears about would just be a slower version of the bug
 * this replaces.
 *
 * Runs on a timer rather than at a turn boundary: a turn ending is not
 * evidence the requester's question went unanswered (Codex may open
 * another turn on it moments later), and a single global flag armed
 * against "the current turn" is exactly the coupling this task removes.
 *
 * Routed through the bus (`routeOrLog`), not the wake-only
 * `notifyFrontends`, so the notice lands in the requester's mailbox and
 * survives a reconnect the same way any other message does — a request
 * is not answered just because the requester's socket blipped, and the
 * notice that it wasn't must not be lost the same way.
 *
 * Emitted as `reply_missing`, in the `reply_*` family alongside
 * `reply_expired` / `reply_delivered` / `reply_undeliverable` /
 * `reply_discarded` — not `system_*`. Every `system_*` id is wake-only
 * by convention (Task 11: a statusbar tag with no reply semantics must
 * never occupy a mailbox slot), but this notice is routed through the
 * bus deliberately, same as its `reply_*` siblings — a loss report, not
 * a statusbar tag. Naming it into that family makes the exception
 * legible instead of a `system_`-prefixed id quietly breaking the
 * convention it appears to follow. Built with `noticeMessage`, so it
 * reaches the sender as content (`bridge.ts`'s `isDaemonLifecycle` only
 * intercepts `system_*` ids into the statusbar; everything else pushes
 * to the model), exactly like the four siblings above.
 */
function checkExpiredRequests(): void {
  const expired = pendingRequests.expire(Date.now(), PENDING_REQUEST_TTL_MS);
  for (const req of expired) {
    log(
      `Reply required for ${req.messageId} expired after ${PENDING_REQUEST_TTL_MS}ms without a reply (requester: ${req.requester})`,
    );
    routeOrLog(
      noticeMessage(
        "reply_missing",
        `⚠️ ${agentLabel(req.responder)} did not send a reply before the reply-required window expired. You may want to retry or rephrase.`,
        req.requester,
      ),
    );
  }
}

/**
 * Is anyone still using this daemon?
 *
 * A Grok TUI is a client in every sense that matters here: it is
 * connected through the daemon's own proxy socket, and killing the
 * daemon takes its session's leader connection down with it. It counts
 * for the same reason the Codex TUI does — and it has to be counted in
 * both the initial check and the re-check, or the grace period becomes a
 * window in which attaching Grok does not save the daemon.
 */
function hasLiveClients(): boolean {
  return frontends.size > 0 || tuiConnectionState.snapshot().tuiConnected || grok.tuiConnected;
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (hasLiveClients()) return;

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    // Re-check before shutting down
    if (hasLiveClients()) {
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

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage, deliveryHint?: "push" | "queue"): boolean {
  try {
    const egressMessage = forEgress(message, ws.data.protocolVersion);
    const payload: ControlServerMessage = deliveryHint
      ? { type: "codex_to_claude", message: egressMessage, deliveryHint }
      : { type: "codex_to_claude", message: egressMessage };
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

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  for (const { socket } of frontends.writable()) {
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
    // Retention now lives in the mailboxes, so this counts what is
    // actually still owed to someone rather than what failed to send.
    queuedMessageCount:
      [...mailboxes.values()].reduce((n, box) => n + box.size, 0) + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
    claudeAttached: frontends.isAttached(DEFAULT_FRONTEND_AGENT),
    attachedAgents: frontends.attachedAgents(),
    pendingReplyCount: replyOutbox.size,
    grokProxyReady: grok.proxyListening,
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

function systemMessage(idPrefix: string, content: string, to: AgentId): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    from: "system",
    to,
    kind: "untagged",
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
function noticeMessage(idPrefix: string, content: string, to: AgentId): BridgeMessage {
  return {
    id: `notice_${idPrefix}_${++nextSystemMessageId}`,
    from: "system",
    to,
    kind: "untagged",
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

    notifyFrontends((to) => systemMessage("system_waiting", currentWaitingMessage(), to));
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start Codex: ${err.message}`);
    notifyFrontends((to) =>
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start Codex app-server: ${err.message}`,
        to,
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
  if (pendingRequestsTimer) {
    clearInterval(pendingRequestsTimer);
    pendingRequestsTimer = null;
  }
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  grok.stop();
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
pendingRequestsTimer = setInterval(checkExpiredRequests, PENDING_REQUEST_CHECK_INTERVAL_MS);
startupComplete = true;
// Independent of Codex on purpose: the Grok socket only has to exist
// before `abg grok` points a TUI at it, and a Codex app-server that
// fails to start is no reason for the Grok side to be unreachable.
try {
  grok.start();
} catch (err: unknown) {
  log(`Failed to open the Grok proxy socket: ${describeError(err)}`);
}
void bootCodex();
