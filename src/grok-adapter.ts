import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRotatingLogger } from "./log-rotator";
import {
  GROK_ACP_PROTOCOL_VERSION,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcRequest,
  updateText,
  type GrokSessionUpdate,
  type JsonRpcResponse,
} from "./grok-acp";
import {
  LeaderFramer,
  encodeAcpFrame,
  readAcpFrame,
  registerFrame,
} from "./grok-leader-protocol";

/**
 * What the adapter knows about a message it intercepts from Grok: the
 * session and turn it came from, and the prose. Mirrors
 * `CodexProseIngress` — routing and the canonical id belong to the
 * daemon's ingress path, not to an adapter.
 */
export interface GrokProseIngress {
  senderRef: string;
  content: string;
  /**
   * The injected prompt this turn is an answer to, when it is one.
   *
   * Null for a turn the human started. Set, the daemon knows two things
   * it cannot otherwise recover: who is owed this reply (so an untagged
   * one goes back to the requester instead of being broadcast), and
   * which `require_reply` it settles.
   */
  respondingTo: GrokInjectionCorrelation | null;
}

/**
 * How long the proxy leg must be quiet before an injected turn is over.
 *
 * Covers the skew between two sockets carrying one turn — see
 * `armInjectedCompletion`. Long enough that ordinary scheduling jitter
 * cannot beat it, short enough to be invisible next to a model turn.
 */
const INJECTED_TURN_SETTLE_MS = 250;

/**
 * How long a correlation orphaned by a dead injector connection waits
 * for the turn it belongs to to start streaming.
 *
 * Sized against a model, not against a socket: the prompt may already
 * have reached the leader, and the first token of its answer is thinking
 * time away. See `failInflightInjections`.
 */
const ORPHANED_INJECTION_WINDOW_MS = 60_000;

/**
 * How many injected prompts may wait behind the one in flight.
 *
 * Injection is serialised (see `injectMessage`), so a backlog drain that
 * hands the adapter twenty messages queues nineteen. The cap is what
 * keeps that queue from being an unbounded buffer in front of a mailbox
 * that already is one: past it, injection refuses, the wake throws, and
 * the message stays where it can be retried.
 */
const MAX_QUEUED_INJECTIONS = 32;

/**
 * What became of an injected prompt that did not visibly run.
 *
 * - `rejected` — the leader answered with a JSON-RPC error. The prompt
 *   did not run and Grok never saw it. Safe to say so, safe to resend.
 * - `unknown` — the connection died with the prompt in flight. The bytes
 *   were written; whether the leader read and ran them is not knowable
 *   from here. A resend may duplicate whatever the turn already did.
 */
export type GrokInjectionDelivery = "rejected" | "unknown";

/** Why an injected turn did not visibly run. */
export interface GrokInjectionRejection {
  messageId: string;
  requester: string;
  text: string;
  reason: string;
  delivery: GrokInjectionDelivery;
}

export interface GrokInjectionCorrelation {
  messageId: string;
  requester: string;
  text: string;
}

/**
 * One byte-stream socket, behind an interface, so tests do not open
 * unix sockets or spawn Grok.
 */
export interface LeaderConnection {
  write(data: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** The listening half: accepts the Grok TUI's connections. */
export interface ProxyServer {
  onConnection(cb: (client: LeaderConnection) => void): void;
  /**
   * Called once the socket is actually bound. Optional because `listen`
   * on a unix socket succeeds asynchronously and a test fake is bound
   * the moment it is made — a fake without this is treated as ready.
   */
  onListening?(cb: () => void): void;
  close(): void;
}

export interface GrokAdapterOptions {
  /** Where the TUI is told to connect (`grok --leader-socket <path>`). */
  socketPath: string;
  /** The real leader this proxy forwards to. Defaults to `~/.grok/leader.sock`. */
  upstreamPath?: string;
  logFile?: string;
  /**
   * How long to wait for the proxy leg to go quiet before closing an
   * injected turn. See `armInjectedCompletion`. Injected by tests.
   */
  injectedTurnSettleMs?: number;
  /**
   * How long a correlation orphaned by a dead injector connection waits
   * for its turn to appear. See `failInflightInjections`. Injected by tests.
   */
  orphanedInjectionWindowMs?: number;
  /** Injected by tests. */
  createServer?: () => ProxyServer;
  /** Injected by tests. Called once per TUI connection, plus once for injection. */
  createUpstream?: () => LeaderConnection;
}

/**
 * Bridges a live Grok Build session into the bus.
 *
 * Same topology as `CodexAdapter`, reached by a different road. The
 * daemon owns a socket, the TUI is launched pointing at it
 * (`grok --leader-socket`), and every frame between the TUI and the real
 * leader passes through here. That is what buys the behaviour Codex has
 * and a passive listener cannot: the TUI's own `session/prompt` and the
 * leader's response to it are both visible, so a turn ends when the
 * leader says it ended rather than when the output happens to go quiet.
 *
 * Injection deliberately does *not* reuse the TUI's connection. The
 * leader accepts `session/prompt` for a session from any client, so the
 * adapter opens its own connection and prompts from there. Sharing the
 * TUI's connection would mean sharing its JSON-RPC id space, and the
 * only way to keep the two apart is to rewrite ids on every frame in
 * both directions — a translation layer over the human's live session,
 * bought for nothing. A second connection has its own id space by
 * construction.
 *
 * So: the proxy observes, the client injects.
 */
export class GrokAdapter extends EventEmitter {
  private server: ProxyServer | null = null;
  /** The TUI's leg of the proxy, when a TUI is connected. */
  private tui: LeaderConnection | null = null;
  /** Our own connection to the leader, used only to inject. */
  private injector: LeaderConnection | null = null;

  private sessionIdValue: string | null = null;
  private turnActive = false;
  /** JSON-RPC id of the TUI's in-flight `session/prompt`, when there is one. */
  private tuiTurnRequestId: string | number | null = null;
  private chunks: string[] = [];
  private turnSeq = 0;

  private nextRequestId = 1;
  private readonly injectionCorrelations = new Map<number, GrokInjectionCorrelation>();
  /** Ids of our own in-flight prompts, so their responses are recognised. */
  private readonly ourPrompts = new Set<number>();

  /**
   * An injected turn whose leader response has arrived, waiting for the
   * proxy leg to finish streaming it. See `armInjectedCompletion`.
   */
  private injectedCompletion: {
    correlation: GrokInjectionCorrelation | null;
    reason: string;
    timer: ReturnType<typeof setTimeout>;
    /**
     * When to stop waiting for a turn that has not started.
     *
     * The settle timer answers "has the prose stopped?", which is only a
     * question once prose has started. Before that the same timer is
     * asking "is a turn coming at all?", and the two need different
     * patience: 250ms of socket skew versus a model's thinking time.
     * Firing against an empty buffer re-arms until this deadline.
     */
    deadline: number;
  } | null = null;

  /**
   * Injected prompts waiting for the one in flight to finish. See
   * `injectMessage`.
   */
  private readonly injectionQueue: { text: string; correlation?: GrokInjectionCorrelation }[] = [];

  private stopped = false;
  /** Whether the proxy socket is bound. `listen` reports it asynchronously. */
  private listening = false;

  private readonly socketPath: string;
  private readonly upstreamPath: string;
  private readonly settleMs: number;
  private readonly orphanWindowMs: number;
  private readonly logFile: string | null;
  private readonly makeServer: () => ProxyServer;
  private readonly makeUpstream: () => LeaderConnection;

  constructor(options: GrokAdapterOptions) {
    super();
    this.socketPath = options.socketPath;
    this.upstreamPath = options.upstreamPath ?? defaultLeaderSocket();
    this.settleMs = options.injectedTurnSettleMs ?? INJECTED_TURN_SETTLE_MS;
    this.orphanWindowMs = options.orphanedInjectionWindowMs ?? ORPHANED_INJECTION_WINDOW_MS;
    this.logFile = options.logFile ?? null;
    this.makeServer =
      options.createServer ??
      (() =>
        listenUnix(this.socketPath, (err) =>
          this.log(`Cannot listen on ${this.socketPath}: ${describe(err)}`),
        ));
    this.makeUpstream = options.createUpstream ?? (() => connectUnix(this.upstreamPath));
  }

  /** Path to hand `grok --leader-socket`. */
  get proxySocketPath(): string {
    return this.socketPath;
  }

  /** The session the TUI is working in, or null before it has one. */
  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  /** True while the leader has an unanswered prompt for our session. */
  get turnPending(): boolean {
    return this.turnActive;
  }

  /** True while a Grok TUI is connected through the proxy. */
  get tuiConnected(): boolean {
    return this.tui !== null;
  }

  /**
   * True once the proxy socket is bound and a TUI could connect.
   *
   * Reported through `/healthz` so `abg grok` can ask instead of
   * connecting — see `DaemonLifecycle.isGrokProxyReady`.
   */
  get proxyListening(): boolean {
    return this.listening;
  }

  /**
   * Start listening. Does not require a leader or a TUI to exist yet —
   * the socket is the thing `abg grok` needs to point the TUI at, and it
   * has to exist before there is anything to point.
   */
  start(): void {
    const server = this.makeServer();
    this.server = server;
    server.onConnection((client) => this.attachTui(client));
    if (server.onListening) {
      server.onListening(() => {
        this.listening = true;
        this.log(`Listening for the Grok TUI on ${this.socketPath}`);
      });
    } else {
      this.listening = true;
    }
  }

  stop(): void {
    this.stopped = true;
    this.listening = false;
    for (const q of this.injectionQueue.splice(0)) {
      this.reportUndelivered(q.correlation, "the bridge stopped before the prompt was sent", "rejected");
    }
    this.takeInjectedCompletion();
    this.tui?.close();
    this.injector?.close();
    this.server?.close();
    this.tui = null;
    this.injector = null;
    this.server = null;
    this.sessionIdValue = null;
  }

  /**
   * Send a message into the live Grok session.
   *
   * Returns whether the frame reached the wire — the same weak promise
   * `CodexAdapter.injectMessage` makes, for the same reason: a refusal
   * comes back later and asynchronously, correlated through
   * `injectionRejected`.
   *
   * Note what is *not* here: a turn-in-progress guard against the
   * *human's* turn. Codex needs one because a second `turn/start`
   * mid-turn is an error. Grok's leader queues the prompt and runs it at
   * the next turn boundary, so refusing there would re-implement, worse,
   * something the server already does.
   *
   * What *is* here is a guard against a second *injected* turn. The two
   * facts about an injected turn arrive on two sockets with no ordering
   * between them (see `armInjectedCompletion`), and the proxy leg's prose
   * carries no prompt id — so with two injections outstanding there is
   * nothing in the stream that says which turn is streaming. The second
   * verdict would close the first turn against whatever happened to be
   * buffered and take its correlation with it. Serialising is what makes
   * the correlation unambiguous rather than merely usually right: one
   * injected turn at a time, the rest queued here and sent as each turn
   * closes. The leader would have run them one at a time regardless.
   */
  injectMessage(text: string, correlation?: GrokInjectionCorrelation): boolean {
    if (this.sessionIdValue === null) {
      this.log("Cannot inject: no Grok session to inject into");
      return false;
    }
    if (this.injectionBusy) {
      if (this.injectionQueue.length >= MAX_QUEUED_INJECTIONS) {
        this.log(`Cannot inject: ${MAX_QUEUED_INJECTIONS} prompts already queued`);
        return false;
      }
      this.injectionQueue.push({ text, correlation });
      this.log(`Queued injection behind the turn in flight (${this.injectionQueue.length} waiting)`);
      return true;
    }
    return this.writeInjection(text, correlation);
  }

  /**
   * True from the moment a prompt is written until its turn is fully
   * accounted for — the verdict arrived *and* the settle window closed.
   * Not merely "a prompt is in flight": the window is exactly the period
   * where a second correlation would be ambiguous.
   */
  private get injectionBusy(): boolean {
    return this.ourPrompts.size > 0 || this.injectedCompletion !== null;
  }

  /** Send the next queued prompt, if the turn just closed and one waits. */
  private pumpInjectionQueue(): void {
    if (this.stopped || this.injectionBusy) return;
    const next = this.injectionQueue.shift();
    if (!next) return;
    if (!this.writeInjection(next.text, next.correlation)) {
      // Never written, so never run: safe to say so, and safe to resend.
      this.reportUndelivered(next.correlation, "the prompt could not be written to the Grok leader", "rejected");
      this.pumpInjectionQueue();
    }
  }

  /** Put one prompt on the wire. The serialisation gate is the caller's. */
  private writeInjection(text: string, correlation?: GrokInjectionCorrelation): boolean {
    const sessionId = this.sessionIdValue;
    if (sessionId === null) {
      this.log("Cannot inject: no Grok session to inject into");
      return false;
    }
    const injector = this.ensureInjector();
    if (injector === null) return false;

    const id = this.nextRequestId++;
    this.log(`Injecting message into Grok (${text.length} chars)`);
    // Registered before the write, not after: nothing here guarantees
    // the response cannot arrive synchronously, and a correlation
    // installed afterwards would miss the refusal it exists to report.
    if (correlation) this.injectionCorrelations.set(id, correlation);
    this.ourPrompts.add(id);
    try {
      injector.write(encodeAcpFrame({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      }));
    } catch (err) {
      this.injectionCorrelations.delete(id);
      this.ourPrompts.delete(id);
      this.log(`Injection send failed: ${describe(err)}`);
      return false;
    }
    return true;
  }

  // ── The proxy leg ──────────────────────────────────────────

  /**
   * Wire one TUI connection to the real leader and watch what crosses.
   *
   * Forwarding is unconditional and happens before any interpretation:
   * whatever the bridge fails to understand must still reach the human's
   * session intact. Observation is a side effect of the pipe, never a
   * gate on it.
   */
  private attachTui(client: LeaderConnection): void {
    if (this.stopped) {
      client.close();
      return;
    }
    if (this.tui !== null) {
      // A second TUI on one project's socket would interleave two
      // sessions' turns into one bus identity. The bridge has one Grok.
      this.log("Refusing a second Grok TUI on this project's leader socket");
      client.close();
      return;
    }

    let upstream: LeaderConnection;
    try {
      upstream = this.makeUpstream();
    } catch (err) {
      this.log(`Cannot reach the Grok leader at ${this.upstreamPath}: ${describe(err)}`);
      client.close();
      return;
    }

    this.tui = client;
    this.log("Grok TUI connected through the proxy");
    this.emit("tuiConnected");

    const fromTui = new LeaderFramer();
    const fromLeader = new LeaderFramer();

    client.onData((chunk) => {
      upstream.write(chunk);
      this.observe(fromTui, chunk, (acp) => this.observeFromTui(acp));
    });
    upstream.onData((chunk) => {
      client.write(chunk);
      this.observe(fromLeader, chunk, (acp) => this.observeFromLeader(acp));
    });

    const teardown = () => {
      if (this.tui !== client) return;
      this.tui = null;
      client.close();
      upstream.close();
      // A turn that was mid-flight will never get its response now. Its
      // prose is real and already streamed, so it goes to the bus rather
      // than being held for a boundary that is not coming.
      this.flush("the Grok TUI disconnected");
      this.sessionIdValue = null;
      this.log("Grok TUI disconnected");
      this.emit("tuiDisconnected");
    };
    client.onClose(teardown);
    upstream.onClose(teardown);
  }

  /**
   * Decode frames without ever letting a decode failure break the pipe.
   *
   * The bytes have already been forwarded by the time this runs. A
   * desynchronised or oversized frame costs the bridge its view of the
   * conversation; it must not cost the human their session.
   */
  private observe(
    framer: LeaderFramer,
    chunk: Buffer,
    handle: (acp: unknown) => void,
  ): void {
    let frames;
    try {
      frames = framer.push(chunk);
    } catch (err) {
      this.log(`Stopped reading a leader stream: ${describe(err)}`);
      return;
    }
    for (const frame of frames) {
      const acp = readAcpFrame(frame);
      if (acp === null) continue;
      try {
        handle(acp);
      } catch (err) {
        this.log(`Failed to interpret a leader frame: ${describe(err)}`);
      }
    }
  }

  /** What the human's TUI asked the leader to do. */
  private observeFromTui(acp: unknown): void {
    if (!isJsonRpcRequest(acp)) return;
    if (acp.method !== "session/prompt") return;
    const sessionId = readSessionId(acp.params);
    if (sessionId === null) return;

    // The session the TUI prompts into is, by definition, the one the
    // human is working in — so this is also how the adapter learns which
    // of the leader's sessions is ours.
    this.bindSession(sessionId);
    this.tuiTurnRequestId = acp.id;
    this.beginTurn();
  }

  /** What the leader sent back down to the TUI. */
  private observeFromLeader(acp: unknown): void {
    if (isJsonRpcResponse(acp)) {
      // Only the answer to the TUI's own prompt ends a turn. Every other
      // response on this leg belongs to a request the TUI made for its
      // own reasons — a settings read, a model list — and says nothing
      // about whether Grok is still talking.
      if (this.tuiTurnRequestId !== null && acp.id === this.tuiTurnRequestId) {
        this.tuiTurnRequestId = null;
        this.flush("the leader answered the TUI's prompt");
      }
      // A `session/new` result is the earliest point a session exists,
      // which is what lets the bus reach Grok before the human types.
      const created = readSessionId((acp as JsonRpcResponse).result);
      if (created !== null && this.sessionIdValue === null) this.bindSession(created);
      return;
    }

    if (!isJsonRpcNotification(acp)) return;
    if (acp.method !== "session/update") return;

    const params = acp.params as { sessionId?: string; update?: GrokSessionUpdate } | undefined;
    // The leader is machine-wide and fans every session it hosts out to
    // every client, including this one. Ours only.
    if (this.sessionIdValue === null || params?.sessionId !== this.sessionIdValue) return;

    const update = params.update;
    const kind = update?.sessionUpdate;

    // Our own injected text comes back as a user message, because from
    // the session's point of view that is exactly what it is. Forwarding
    // it would put the bus's own message back on the bus. It also marks
    // a turn boundary the TUI never announced, because the prompt that
    // opened it came from us.
    if (kind === "user_message_chunk") {
      this.flush("a user message started a new turn");
      // Our own injected prompt echoes back here, and it echoes back
      // *before* the answer to it. A settle window opened by the
      // leader's verdict is therefore waiting on prose that has not
      // started yet — the echo is evidence it is about to. Push the
      // window out rather than letting it fire in the gap.
      this.rearmInjectedCompletion();
      return;
    }
    if (kind !== "agent_message_chunk") return;

    const text = updateText(update);
    if (text === null) return;
    this.beginTurn();
    this.chunks.push(text);
    // The leader may already have told us this turn is over on the other
    // socket. More of it just arrived, so it is not.
    this.rearmInjectedCompletion();
  }

  // ── The injection leg ──────────────────────────────────────

  /** Our own leader connection, opened on first use and kept. */
  private ensureInjector(): LeaderConnection | null {
    if (this.injector !== null) return this.injector;
    let conn: LeaderConnection;
    try {
      conn = this.makeUpstream();
    } catch (err) {
      this.log(`Cannot open an injection connection to the leader: ${describe(err)}`);
      return null;
    }
    const framer = new LeaderFramer();
    conn.onData((chunk) => this.observe(framer, chunk, (acp) => this.observeInjectorReply(acp)));
    conn.onClose(() => {
      if (this.injector === conn) this.injector = null;
      this.log("Injection connection to the leader closed");
      this.failInflightInjections(
        "the bridge's connection to the Grok leader closed before the prompt was answered",
      );
    });
    try {
      conn.write(registerFrame("agentbridge (bus injector)"));
      conn.write(encodeAcpFrame({
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "initialize",
        params: {
          protocolVersion: GROK_ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
      }));
    } catch (err) {
      this.log(`Injection handshake failed: ${describe(err)}`);
      conn.close();
      return null;
    }
    this.injector = conn;
    return conn;
  }

  /**
   * Responses to our own prompts.
   *
   * Deliberately ignores `session/update` on this leg: the leader fans
   * the same updates to every client, and the proxy leg already
   * accumulates them. Reading both would double every message.
   *
   * Both outcomes are turn boundaries, and both have to be acted on. A
   * refusal is a delivery the daemon already reported as sent. A success
   * closes a turn the TUI never opened — the prompt came from here, so
   * the TUI has no `session/prompt` of its own outstanding and nothing
   * on the proxy leg will ever end this turn. Without the flush, an
   * injected turn's answer sits in `chunks` until the human happens to
   * type again.
   */
  private observeInjectorReply(acp: unknown): void {
    if (!isJsonRpcResponse(acp)) return;
    if (typeof acp.id !== "number" || !this.ourPrompts.has(acp.id)) return;
    this.ourPrompts.delete(acp.id);
    const correlation = this.injectionCorrelations.get(acp.id) ?? null;
    this.injectionCorrelations.delete(acp.id);
    if (!acp.error) {
      this.armInjectedCompletion("the leader answered our injected prompt", correlation);
      return;
    }
    const reason = acp.error.message || "Grok refused the prompt";
    this.log(`Injection rejected: ${reason}`);
    this.reportUndelivered(correlation, reason, "rejected");
    // The turn that will never run is not holding the queue any more.
    this.pumpInjectionQueue();
  }

  /** Tell the daemon an injected prompt did not visibly run. */
  private reportUndelivered(
    correlation: GrokInjectionCorrelation | null | undefined,
    reason: string,
    delivery: GrokInjectionDelivery,
  ): void {
    if (!correlation) return;
    this.emit("injectionRejected", {
      ...correlation,
      reason,
      delivery,
    } satisfies GrokInjectionRejection);
  }

  /**
   * Close an injected turn once the prose for it has stopped arriving.
   *
   * The two facts about one turn reach the bridge on two different
   * sockets: the prose streams down the proxy leg as `session/update`
   * fan-out, and the "this turn is over" response comes back on the
   * injector leg. Nothing orders one socket against the other. Flushing
   * the moment the response landed therefore raced the stream it was
   * describing — the response could win, `flush` would find an empty
   * buffer, and the prose that arrived a moment later sat in `chunks`
   * with its correlation already discarded: no turn boundary, no
   * `respondingTo`, and a `require_reply` that could never be satisfied.
   *
   * So the response arms a settle window instead of ending the turn, and
   * every chunk that arrives re-arms it. The turn ends when the leader's
   * verdict has landed *and* the proxy leg has been quiet for
   * `settleMs`. The cost is that an injected turn's answer reaches the
   * bus `settleMs` late; the alternative is losing it.
   */
  private armInjectedCompletion(
    reason: string,
    correlation: GrokInjectionCorrelation | null,
    windowMs: number = this.settleMs,
  ): void {
    // Injection is serialised, so there is never a second window to
    // reconcile with this one. It used to close the older one here, which
    // — with nothing streamed yet, the ordinary case when two verdicts
    // beat their prose — flushed an empty buffer and dropped the first
    // correlation on the floor. Serialising removed the situation rather
    // than the symptom; this is the assertion that it stays removed.
    if (this.injectedCompletion) {
      this.log("BUG: a second injected completion armed while one was pending");
      this.settleInjectedCompletion();
    }
    this.injectedCompletion = {
      correlation,
      reason,
      deadline: Date.now() + windowMs,
      timer: setTimeout(() => this.settleInjectedCompletion(), windowMs),
    };
    this.injectedCompletion.timer.unref?.();
  }

  /** Restart the settle window because more of the turn just arrived. */
  private rearmInjectedCompletion(): void {
    const pending = this.injectedCompletion;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.settleInjectedCompletion(), this.settleMs);
    pending.timer.unref?.();
  }

  /** End the injected turn the settle window was holding open. */
  private settleInjectedCompletion(): void {
    const pending = this.injectedCompletion;
    if (!pending) return;

    // Nothing has streamed yet, so this window is not measuring silence
    // after a turn — it is still waiting for one to start. Consuming the
    // correlation here is how a slow first token used to cost an answer
    // its attribution: the leader's verdict arms the window, the echo of
    // our own prompt re-arms it at the *short* settle interval, and it
    // fires in the gap before the model's first chunk. Keep waiting
    // until the deadline the window was armed with.
    if (!this.turnActive && this.chunks.length === 0) {
      const remaining = pending.deadline - Date.now();
      if (remaining > 0) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () => this.settleInjectedCompletion(),
          Math.min(this.settleMs, remaining),
        );
        pending.timer.unref?.();
        return;
      }
      // Out of patience. No turn is coming — say so rather than dropping
      // it through an empty `flush`, which reports nothing at all.
      this.takeInjectedCompletion();
      if (pending.correlation) {
        this.log(`Giving up on the turn for ${pending.correlation.messageId}: ${pending.reason}`);
      }
      this.pumpInjectionQueue();
      return;
    }

    this.takeInjectedCompletion();
    this.flush(pending.reason, pending.correlation);
    this.pumpInjectionQueue();
  }

  /** Disarm the settle window and hand back what it was holding. */
  private takeInjectedCompletion() {
    const pending = this.injectedCompletion;
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.injectedCompletion = null;
    return pending;
  }

  /**
   * Report every prompt still in flight when the injection connection dies.
   *
   * The transport self-acks (`acknowledgementMode: "none"`), so by the
   * time a prompt is on this connection the mailbox copy is gone. A
   * connection that closes mid-flight is therefore indistinguishable, to
   * everything downstream, from a delivery that worked — the message is
   * simply never mentioned again. Reporting each one is what keeps that
   * from being a silent loss.
   *
   * Reported as `unknown`, never as rejected. The bytes were written
   * before the socket died and the leader may well have run the prompt;
   * saying "Grok never saw it" would be a claim this side cannot make,
   * and acting on it — a resend — can run the same turn twice, with
   * whatever file writes and tool calls that turn made.
   */
  private failInflightInjections(reason: string): void {
    // Queued prompts never reached the wire, so unlike the one in flight
    // their fate is knowable: Grok did not see them, and a resend cannot
    // duplicate anything.
    const queued = this.injectionQueue.splice(0);
    for (const q of queued) {
      this.reportUndelivered(q.correlation, "the prompt was never sent to the Grok leader", "rejected");
    }
    if (this.ourPrompts.size === 0) return;
    this.log(`Failing ${this.ourPrompts.size} in-flight injection(s): ${reason}`);
    const inflight = [...this.ourPrompts];
    this.ourPrompts.clear();
    for (const id of inflight) {
      const correlation = this.injectionCorrelations.get(id);
      this.injectionCorrelations.delete(id);
      if (correlation) {
        this.emit("injectionRejected", {
          ...correlation,
          reason,
          delivery: "unknown",
        } satisfies GrokInjectionRejection);
        // "Unknown" cuts both ways. The leader may well be running this
        // prompt right now, and its answer will stream down the proxy
        // leg like any other — but the verdict that would have closed
        // the turn is never coming, because the socket it would have
        // arrived on is gone. Dropping the correlation here would leave
        // that answer unattributed: no `respondingTo`, no requester, and
        // a `require_reply` its own reply could not satisfy.
        //
        // So the correlation is handed to a settle window instead, one
        // wide enough to cover the model's thinking time rather than the
        // gap between two sockets. If prose starts, the first chunk
        // re-arms it at the normal `settleMs` and the turn closes the
        // usual way; if nothing arrives, the window fires against an
        // empty buffer and the correlation is dropped with it.
        this.armInjectedCompletion(reason, correlation, this.orphanWindowMs);
      }
    }
  }

  // ── Turn bookkeeping ───────────────────────────────────────

  private bindSession(sessionId: string): void {
    if (this.sessionIdValue === sessionId) return;
    this.sessionIdValue = sessionId;
    this.log(`Attached to Grok session ${sessionId}`);
    this.emit("sessionAttached", sessionId);
  }

  private beginTurn(): void {
    if (this.turnActive) return;
    this.turnActive = true;
    this.turnSeq += 1;
    this.emit("turnStarted");
  }

  private flush(reason: string, respondingTo: GrokInjectionCorrelation | null = null): void {
    // Nothing to end — and, crucially, nothing to attribute. A settle
    // window open at this point belongs to a turn that has not arrived
    // yet, not to this empty flush: the leader's verdict can beat both
    // the prose it describes *and* the echo of our own injected prompt
    // across the two sockets, and that echo lands here. Consuming the
    // correlation on the way past would leave the answer, when it
    // finally streams in, with no `respondingTo` and no boundary.
    if (!this.turnActive && this.chunks.length === 0) return;
    // Past this point a real turn is ending, so it takes ownership of
    // any window still open on it — a TUI disconnect, or the next turn
    // starting. Leaving it armed would fire it against the *following*
    // turn's buffer and attribute that turn to this injection.
    const held = this.takeInjectedCompletion();
    respondingTo ??= held?.correlation ?? null;
    const content = this.chunks.join("");
    const senderRef = `${this.sessionIdValue ?? "grok"}#${this.turnSeq}`;
    this.chunks = [];
    this.turnActive = false;
    if (content.trim()) {
      this.log(`Grok message completed (${content.length} chars, ${reason})`);
      this.emit("agentMessage", { senderRef, content, respondingTo } satisfies GrokProseIngress);
    }
    this.emit("turnCompleted");
    // A turn ending here — a TUI disconnect, or the human's next prompt —
    // consumed the window just as a settle would have, so the queue is
    // free either way.
    if (held) this.pumpInjectionQueue();
  }

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] [GrokAdapter] ${msg}\n`;
    process.stderr.write(line);
    if (this.logFile) getRotatingLogger(this.logFile).write(line);
  }
}

/** Where Grok puts the machine-wide leader when nobody says otherwise. */
export function defaultLeaderSocket(): string {
  return join(homedir(), ".grok", "leader.sock");
}

function readSessionId(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const id = (params as Record<string, unknown>).sessionId;
  return typeof id === "string" ? id : null;
}

function wrapSocket(socket: Socket): LeaderConnection {
  return {
    write(data) {
      socket.write(data);
    },
    onData(cb) {
      socket.on("data", (chunk: Buffer) => cb(chunk));
    },
    onClose(cb) {
      socket.on("close", cb);
      // An error is always followed by `close`, but the listener has to
      // exist or node raises the error as an uncaught exception.
      socket.on("error", () => {});
    },
    close() {
      socket.destroy();
    },
  };
}

function connectUnix(path: string): LeaderConnection {
  return wrapSocket(connect(path));
}

/**
 * Listen on the project's proxy socket.
 *
 * A leftover socket file from a daemon that did not shut down cleanly
 * would make `listen` fail with EADDRINUSE forever, so a stale one is
 * removed first. This is safe because the path is per-project state the
 * daemon owns: a *live* daemon holds the control port, and the caller
 * has already lost that race by the time it gets here.
 */
function listenUnix(path: string, onError: (err: unknown) => void): ProxyServer {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // `listen` will report it far better than we can.
    }
  }
  const server: Server = createServer();
  server.listen(path);
  // `listen` fails asynchronously, so `start`'s try/catch cannot see it.
  // Swallowing it here left the daemon believing it was proxying Grok
  // while nothing was bound — and the only symptom was `abg grok`
  // hanging on connect. The error has to reach the log.
  server.on("error", onError);
  return {
    onConnection(cb) {
      server.on("connection", (socket: Socket) => cb(wrapSocket(socket)));
    },
    onListening(cb) {
      if (server.listening) cb();
      else server.on("listening", cb);
    },
    close() {
      server.close();
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Best effort; the next start unlinks it anyway.
      }
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
