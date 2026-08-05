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
  } | null = null;

  private stopped = false;

  private readonly socketPath: string;
  private readonly upstreamPath: string;
  private readonly settleMs: number;
  private readonly logFile: string | null;
  private readonly makeServer: () => ProxyServer;
  private readonly makeUpstream: () => LeaderConnection;

  constructor(options: GrokAdapterOptions) {
    super();
    this.socketPath = options.socketPath;
    this.upstreamPath = options.upstreamPath ?? defaultLeaderSocket();
    this.settleMs = options.injectedTurnSettleMs ?? INJECTED_TURN_SETTLE_MS;
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
   * Start listening. Does not require a leader or a TUI to exist yet —
   * the socket is the thing `abg grok` needs to point the TUI at, and it
   * has to exist before there is anything to point.
   */
  start(): void {
    const server = this.makeServer();
    this.server = server;
    server.onConnection((client) => this.attachTui(client));
    this.log(`Listening for the Grok TUI on ${this.socketPath}`);
  }

  stop(): void {
    this.stopped = true;
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
   * Note what is *not* here: a turn-in-progress guard. Codex needs one
   * because a second `turn/start` mid-turn is an error. Grok's leader
   * queues the prompt and runs it at the next turn boundary, so refusing
   * here would re-implement, worse, something the server already does.
   */
  injectMessage(text: string, correlation?: GrokInjectionCorrelation): boolean {
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
    if (correlation) {
      this.emit("injectionRejected", {
        ...correlation,
        reason,
        delivery: "rejected",
      } satisfies GrokInjectionRejection);
    }
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
  private armInjectedCompletion(reason: string, correlation: GrokInjectionCorrelation | null): void {
    // A second completion while one is pending means two injected turns
    // ran back to back. The older one's prose is already complete —
    // whatever is in the buffer belongs to it — so close it now rather
    // than letting the new turn's settle window claim it.
    if (this.injectedCompletion) this.settleInjectedCompletion();
    this.injectedCompletion = {
      correlation,
      reason,
      timer: setTimeout(() => this.settleInjectedCompletion(), this.settleMs),
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
    const pending = this.takeInjectedCompletion();
    if (!pending) return;
    this.flush(pending.reason, pending.correlation);
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
    // Whatever ends the turn takes ownership of a settle window still
    // open on it — a TUI disconnect, or the next turn starting. Leaving
    // the window armed would fire it against the *following* turn's
    // buffer and attribute that turn to this injection.
    const held = this.takeInjectedCompletion();
    respondingTo ??= held?.correlation ?? null;
    if (!this.turnActive && this.chunks.length === 0) return;
    const content = this.chunks.join("");
    const senderRef = `${this.sessionIdValue ?? "grok"}#${this.turnSeq}`;
    this.chunks = [];
    this.turnActive = false;
    if (content.trim()) {
      this.log(`Grok message completed (${content.length} chars, ${reason})`);
      this.emit("agentMessage", { senderRef, content, respondingTo } satisfies GrokProseIngress);
    }
    this.emit("turnCompleted");
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
