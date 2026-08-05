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
 * How long an injected turn may go unaccounted for before the adapter
 * stops waiting for it.
 *
 * Sized against a model, not against a socket. Every other bound in here
 * measures skew between two connections; this one measures the gap
 * between writing a prompt and seeing the first token of its answer, and
 * it is the only thing standing between a leader that never responds and
 * an injection slot held forever.
 */
const INJECTED_TURN_DEADLINE_MS = 60_000;

/**
 * How much of the echo stream to keep while looking for a marker.
 *
 * The marker is short and the scan only needs to span a split across
 * chunk boundaries, so anything past this is a turn that did not carry
 * one.
 */
const ECHO_SCAN_WINDOW = 512;

/**
 * A per-injection identity, written into the prompt and looked for in
 * its echo.
 *
 * Matching the prompt's own text was not identity: a human who types the
 * same string — `continue`, or the message they are answering — produces
 * an echo indistinguishable from ours, and their turn walks off with the
 * correlation. This is unique per prompt.
 *
 * Built from zero-width characters so it is invisible in the human's
 * TUI, and encoded rather than numeric so the digits cannot show up
 * either. If a leader ever normalises these away the marker simply never
 * matches, and the injected turn ends at its deadline as `unknown` — a
 * reported non-delivery, which is the failure worth having here.
 * Silently attributing an answer to the wrong message is not.
 */
function echoMarker(id: number): string {
  const bits = id.toString(2);
  let encoded = "";
  for (const bit of bits) encoded += bit === "1" ? "\u200d" : "\u200c";
  return `\u200b${encoded}\u200b`;
}

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
   * How long an injected turn may go unaccounted for before the adapter
   * gives up on it. See `INJECTED_TURN_DEADLINE_MS`. Injected by tests.
   */
  injectedTurnDeadlineMs?: number;
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

  /**
   * The one injected turn the adapter is tracking, from the moment its
   * prompt is written until it is fully accounted for.
   *
   * One, not many. The two facts about an injected turn arrive on two
   * connections with no ordering between them, and the prose on the
   * proxy leg carries no prompt id — so with two turns outstanding
   * nothing in the stream says which is streaming. Serialising is what
   * makes the correlation unambiguous rather than usually right. The
   * leader would have run them one at a time regardless.
   *
   * The correlation is owned from *write* time, not from the verdict.
   * Deriving it later meant every flush that beat the verdict — the
   * human's next prompt, a TUI disconnect — emitted the answer with no
   * owner at all.
   *
   * Owning it is not the same as being allowed to spend it. Grok's
   * leader queues an injected prompt behind whatever the human is
   * already doing, so between the write and the turn there can be one or
   * more turns that are none of our business. `started` is how the turn
   * recognises itself: the leader echoes an injected prompt back down
   * the proxy leg as a user message before answering it, and that echo
   * carries this injection's marker.
   */
  private activeInjection: {
    correlation: GrokInjectionCorrelation | null;
    /** JSON-RPC id of the prompt, so its response is recognised. */
    id: number;
    /** The leader has answered the prompt. No further boundary is coming. */
    verdictSeen: boolean;
    /** Why this turn ended, once something has ended it. */
    reason: string;
    /** The prose for this turn has gone to the bus. */
    proseEmitted: boolean;
    /** This injection's marker, as written into the prompt. */
    marker: string;
    /**
     * Our prompt's echo has come back, so this turn is running and the
     * prose on the proxy leg is now ours to claim.
     *
     * Deliberately a fact of its own rather than something derived from
     * "is there prose buffered". Prose alone was what let the human's
     * turn — the one the leader was already running when we wrote —
     * settle against our correlation.
     */
    started: boolean;
    /** Recent echo text, scanned for the marker across chunk splits. */
    echoSeen: string;
    /**
     * The deadline passed, the sender has been told `unknown`, and the
     * slot is held until something authoritative says the prompt cannot
     * still run.
     *
     * Distinct from `proseEmitted`, which the release path reads as "this
     * turn is fully accounted for, free the slot". Conflating them let a
     * verdict for an abandoned prompt free the slot while its answer was
     * still in flight on the other socket.
     */
    abandoned: boolean;
    /** Absolute give-up point, from write time. */
    deadline: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  private stopped = false;
  /** Whether the proxy socket is bound. `listen` reports it asynchronously. */
  private listening = false;

  private readonly socketPath: string;
  private readonly upstreamPath: string;
  private readonly settleMs: number;
  private readonly deadlineMs: number;
  private readonly logFile: string | null;
  private readonly makeServer: () => ProxyServer;
  private readonly makeUpstream: () => LeaderConnection;

  constructor(options: GrokAdapterOptions) {
    super();
    this.socketPath = options.socketPath;
    this.upstreamPath = options.upstreamPath ?? defaultLeaderSocket();
    this.settleMs = options.injectedTurnSettleMs ?? INJECTED_TURN_SETTLE_MS;
    this.deadlineMs = options.injectedTurnDeadlineMs ?? INJECTED_TURN_DEADLINE_MS;
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
    this.endInjection();
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
   * Refuses while an injected turn is outstanding, and holds no queue of
   * its own. One queue for messages waiting on Grok already exists —
   * Grok's mailbox — and a second one here would be a store the bus
   * cannot see, cannot count against capacity, and cannot redeliver: the
   * transport self-acks, so a message accepted into an adapter-side
   * queue is deleted from the mailbox and exists nowhere else. Refusing
   * makes the wake throw, which is how a transport says "not now" and
   * leaves the entry where it can be retried. `injectionCapacity` is
   * emitted when the slot frees, so the retry is immediate rather than
   * waiting on a lease expiry.
   *
   * Note what is *not* here: a guard against the *human's* turn. Codex
   * needs one because a second `turn/start` mid-turn is an error. Grok's
   * leader queues the prompt and runs it at the next turn boundary, so
   * refusing there would re-implement, worse, something the server
   * already does — and refusing would strand the message, because the
   * retry signal is `injectionCapacity` and no injection would be
   * outstanding to emit it.
   *
   * What that costs is one turn's worth of ambiguity: between this write
   * and our answer there can be human turns whose prose is not ours to
   * claim. The echo marker is what separates them.
   */
  injectMessage(text: string, correlation?: GrokInjectionCorrelation): boolean {
    const sessionId = this.sessionIdValue;
    if (sessionId === null) {
      this.log("Cannot inject: no Grok session to inject into");
      return false;
    }
    if (this.activeInjection !== null) {
      this.log("Cannot inject: an injected turn is still outstanding");
      return false;
    }
    const injector = this.ensureInjector();
    if (injector === null) return false;

    const id = this.nextRequestId++;
    const marker = echoMarker(id);
    this.log(`Injecting message into Grok (${text.length} chars)`);
    // Installed before the write, not after: nothing here guarantees the
    // response cannot arrive synchronously, and state installed
    // afterwards would miss the refusal it exists to report.
    this.activeInjection = {
      correlation: correlation ?? null,
      id,
      verdictSeen: false,
      reason: "",
      proseEmitted: false,
      marker,
      started: false,
      echoSeen: "",
      abandoned: false,
      deadline: Date.now() + this.deadlineMs,
      timer: null,
    };
    this.armInjectionTimer();
    try {
      injector.write(encodeAcpFrame({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        // The marker rides in the prompt because the echo is the only
        // place it can be read back from. Zero-width, so the human's
        // session shows exactly what was sent.
        params: { sessionId, prompt: [{ type: "text", text: text + marker }] },
      }));
    } catch (err) {
      this.endInjection();
      this.log(`Injection send failed: ${describe(err)}`);
      return false;
    }
    return true;
  }

  /**
   * Set the next deadline for the outstanding injected turn.
   *
   * Two different questions share one timer, because which one is being
   * asked depends on what has happened so far:
   *
   * - Prose is buffered and the verdict is in — "has the stream stopped?"
   *   That is socket skew: a settle interval.
   * - Anything else — "is this turn coming at all?" That is a model
   *   thinking, and the answer cannot arrive faster by asking sooner.
   *   Waiting a settle interval here is what cost a slow first token its
   *   correlation: the window fired in the gap before the first chunk.
   */
  private armInjectionTimer(): void {
    const injection = this.activeInjection;
    if (!injection) return;
    if (injection.timer) clearTimeout(injection.timer);
    let wait: number;
    if (injection.abandoned) {
      // Nothing is timed for an abandoned injection until its verdict
      // arrives: the slot is released by evidence, not by waiting
      // longer. Once the verdict is in, one settle interval covers an
      // answer still crossing the other socket, so it reaches the bus
      // before the next prompt goes out.
      if (!injection.verdictSeen) return;
      wait = this.settleMs;
    } else if (this.canSettle(injection)) {
      wait = Math.min(this.settleMs, Math.max(0, injection.deadline - Date.now()));
    } else {
      wait = Math.max(0, injection.deadline - Date.now());
    }
    injection.timer = setTimeout(() => this.onInjectionTimer(), wait);
    injection.timer.unref?.();
  }

  /**
   * Whether buffered prose is this injection's answer, finished.
   *
   * All three have to hold. `started` says the prose belongs to us
   * rather than to the turn the leader was already running; `verdictSeen`
   * says the leader considers it finished; the buffer says there is
   * something to end. Dropping `started` from this is what let the
   * human's turn settle against our correlation when a verdict beat the
   * echo across the sockets.
   */
  private canSettle(injection: NonNullable<GrokAdapter["activeInjection"]>): boolean {
    return injection.started && injection.verdictSeen && (this.turnActive || this.chunks.length > 0);
  }

  /** The outstanding injected turn either settled or ran out of time. */
  private onInjectionTimer(): void {
    const injection = this.activeInjection;
    if (!injection) return;

    if (injection.abandoned) {
      // Only the post-verdict settle arms a timer here, and the verdict
      // is the evidence that releases the slot. Whatever arrived in the
      // meantime goes to the bus unowned — its correlation was reported
      // `unknown` when the deadline passed.
      if (injection.verdictSeen) {
        // Only our own turn's prose may be ended here. If the marker
        // never matched, whatever is buffered belongs to the turn the
        // leader was already running, and flushing it would cut a human
        // turn in half on the way to releasing a slot that has nothing
        // to do with it.
        if (injection.started) {
          this.flush("the abandoned injected turn's answer arrived late");
        }
        this.endInjection();
      }
      return;
    }
    if (this.canSettle(injection)) {
      this.flush(injection.reason || "the injected turn settled");
      this.endInjection();
      return;
    }
    if (Date.now() >= injection.deadline) {
      // Always abandon, never end — buffered prose does not make a
      // deadline into proof that the prompt cannot still run, and the
      // prose may not even be ours if the turn never started.
      this.abandonInjection(
        `no answer streamed within ${this.deadlineMs}ms of the prompt being written`,
      );
      return;
    }
    this.armInjectionTimer();
  }

  /**
   * Give up waiting, tell the sender, and keep holding the slot.
   *
   * A deadline that passes with nothing streamed proves only that this
   * side stopped waiting. The prompt was written; the leader may be
   * queueing it behind a long human turn and may answer it in a minute.
   * So the sender is told `unknown` — the transport self-acked, so
   * without this the message is simply never mentioned again — and the
   * slot stays held. Freeing it would emit `injectionCapacity`, send the
   * next prompt, and leave two turns in flight with one correlation
   * between them: exactly the ambiguity serialising exists to prevent.
   *
   * The slot is released by evidence, not by time: the leader's verdict
   * for this prompt, a different session, or the session going away.
   */
  private abandonInjection(reason: string): void {
    const injection = this.activeInjection;
    if (!injection || injection.abandoned) return;
    if (injection.timer) clearTimeout(injection.timer);
    injection.timer = null;
    injection.abandoned = true;
    this.log(`Giving up on the injected turn: ${reason}`);
    this.reportUndelivered(injection.correlation, reason, "unknown");
    // Every state change re-asks the scheduler what happens next, and
    // abandonment is a state change like any other. Skipping it wedged
    // the slot forever whenever the verdict had already arrived before
    // the deadline: the only thing that arms the post-verdict settle is
    // this call, and nothing else was going to make it.
    this.armInjectionTimer();
  }

  /**
   * Stop tracking the outstanding injected turn and free the slot.
   *
   * `injectionCapacity` is what turns a refusal into a retry: the daemon
   * drains Grok's mailbox again on it, so a message the adapter refused
   * a moment ago goes out as soon as there is somewhere to put it.
   */
  private endInjection(): void {
    const injection = this.activeInjection;
    if (!injection) return;
    if (injection.timer) clearTimeout(injection.timer);
    this.activeInjection = null;
    if (!this.stopped) this.emit("injectionCapacity");
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
      // The observer leg is the only way an injected turn's answer is
      // ever seen. With it gone, an injection that has not already
      // emitted cannot be observed to finish no matter how long the
      // deadline runs — and holding the slot open would refuse
      // injections for a session that no longer exists. Reported
      // `unknown` rather than rejected: the prompt was written, and the
      // leader may have run it where this bridge can no longer watch.
      const injection = this.activeInjection;
      if (injection && !injection.abandoned && !injection.proseEmitted) {
        this.reportUndelivered(
          injection.correlation,
          "the Grok TUI disconnected before the injected turn's answer arrived",
          "unknown",
        );
      }
      this.endInjection();
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
      // Flushed *before* the echo is matched, so the turn this event
      // ends — which may be the human's — cannot claim a correlation
      // whose own turn has not started yet.
      this.flush("a user message started a new turn");
      this.matchInjectionEcho(updateText(update));
      // Deliberately no timer change. The echo of our own injected
      // prompt arrives here, *before* the answer to it — so an
      // outstanding injection is waiting on prose that has not started,
      // which is the deadline's question, not the settle interval's.
      // Shortening the wait on this event is what let a slow first token
      // outlive its own correlation.
      return;
    }
    if (kind !== "agent_message_chunk") return;

    const text = updateText(update);
    if (text === null) return;
    this.beginTurn();
    this.chunks.push(text);
    // The leader may already have said this turn is over on the other
    // connection. More of it just arrived, so it is not — and now that
    // there is prose to attribute, the wait becomes a settle interval.
    this.armInjectionTimer();
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
    const injection = this.activeInjection;
    if (!injection || acp.id !== injection.id) return;

    if (acp.error) {
      const reason = acp.error.message || "Grok refused the prompt";
      this.log(`Injection rejected: ${reason}`);
      // An abandoned injection has already been reported `unknown`. The
      // verdict is still what frees the slot — it is the evidence that
      // the prompt cannot still be waiting to run.
      if (!injection.abandoned) {
        this.reportUndelivered(injection.correlation, reason, "rejected");
      }
      this.endInjection();
      return;
    }

    injection.verdictSeen = true;
    injection.reason = "the leader answered our injected prompt";
    // The prose may already have gone to the bus — the human's next
    // prompt can end this turn before its verdict crosses the other
    // socket. Nothing is left to wait for in that case.
    if (injection.proseEmitted && !injection.abandoned) {
      this.endInjection();
      return;
    }
    // Otherwise the answer may still be crossing the other socket —
    // including for an abandoned injection, whose slot this verdict is
    // the evidence to release. `armInjectionTimer` decides how long that
    // is worth waiting for.
    this.armInjectionTimer();
  }

  /**
   * Recognise our own prompt coming back, and start its turn.
   *
   * The leader queues an injected prompt behind whatever the human is
   * already doing, so the turns between the write and the answer are not
   * ours. The echo is the only marker that distinguishes them: this
   * injection's own marker, returned as a user message immediately
   * before the answer to it. Until it comes back the correlation is
   * owned but unclaimable, which is what stops a human turn ending in
   * between from walking off with it.
   *
   * Scanned across a rolling window rather than matched chunk by chunk,
   * because the leader is free to split a user message anywhere,
   * including through the middle of the marker.
   */
  private matchInjectionEcho(text: string | null): void {
    const injection = this.activeInjection;
    if (!injection || injection.started || text === null) return;
    const seen = (injection.echoSeen + text).slice(-ECHO_SCAN_WINDOW);
    injection.echoSeen = seen;
    if (!seen.includes(injection.marker)) return;
    injection.started = true;
    injection.echoSeen = "";
    this.log("Our injected prompt came back on the proxy leg; its turn has started");
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
   *
   * Terminal for the slot, unlike a deadline. A deadline is this side
   * giving up on evidence that may still arrive; a closed injector is
   * the evidence itself becoming impossible, because the verdict has no
   * socket left to arrive on. Holding the slot for it would wedge every
   * later injection until the session ended. The correlation is spent
   * here, so an answer the leader streams anyway reaches the bus at the
   * next turn boundary owned by nobody — which is what the sender was
   * just told.
   */
  private failInflightInjections(reason: string): void {
    const injection = this.activeInjection;
    // A verdict already in hand means this turn is accounted for and the
    // settle timer owns what happens next; the socket closing after that
    // says nothing new.
    if (!injection || injection.verdictSeen) return;
    this.log(`Failing the in-flight injection: ${reason}`);
    // An abandoned injection has already been reported `unknown`; saying
    // it twice would have the sender act on one message two ways.
    if (!injection.abandoned) {
      this.reportUndelivered(injection.correlation, reason, "unknown");
    }
    this.endInjection();
  }


  // ── Turn bookkeeping ───────────────────────────────────────

  private bindSession(sessionId: string): void {
    if (this.sessionIdValue === sessionId) return;
    // Whatever was outstanding was addressed to the session being left.
    // It cannot run here now, which is the evidence an abandoned
    // injection was holding its slot waiting for.
    if (this.sessionIdValue !== null) {
      const injection = this.activeInjection;
      if (injection && !injection.abandoned && !injection.proseEmitted) {
        this.reportUndelivered(
          injection.correlation,
          "the Grok session changed before the injected turn's answer arrived",
          "unknown",
        );
      }
      this.endInjection();
    }
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

  private flush(reason: string): void {
    // Nothing to end and nothing to attribute. An injected turn
    // outstanding at this point has not started streaming, so it is not
    // this flush's to claim: the leader's verdict can beat both the
    // prose it describes *and* the echo of our own injected prompt
    // across the two connections, and that echo lands here.
    if (!this.turnActive && this.chunks.length === 0) return;

    // Whatever is buffered belongs to the outstanding injected turn, if
    // that turn has started, whether or not its verdict has arrived —
    // the correlation has been owned since the prompt was written
    // precisely so that a flush arriving first does not have to guess.
    // Claimed once: a second turn's prose is not this injection's answer.
    const injection = this.activeInjection;
    let respondingTo: GrokInjectionCorrelation | null = null;
    // `started` is the whole gate: our prompt has come back, so what is
    // buffered is the answer to it and not a human turn the leader ran
    // first. An abandoned injection is excluded because its correlation
    // has already been reported `unknown` to the sender.
    if (injection && injection.started && !injection.abandoned && !injection.proseEmitted) {
      injection.proseEmitted = true;
      respondingTo = injection.correlation;
    }

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
