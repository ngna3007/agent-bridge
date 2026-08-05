#!/usr/bin/env bun
// @bun

// src/codex-adapter.ts
import { spawn, execSync, execFileSync } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { readFileSync, rmSync, writeFileSync } from "fs";

// src/state-dir.ts
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

class StateDirResolver {
  stateDir;
  constructor(envOverride) {
    const override = envOverride ?? process.env.AGENTBRIDGE_STATE_DIR;
    if (override) {
      this.stateDir = override;
    } else if (platform() === "darwin") {
      this.stateDir = join(homedir(), "Library", "Application Support", "AgentBridge");
    } else {
      const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
      this.stateDir = join(xdgState, "agentbridge");
    }
  }
  ensure() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }
  get dir() {
    return this.stateDir;
  }
  get pidFile() {
    return join(this.stateDir, "daemon.pid");
  }
  get tuiPidFile() {
    return join(this.stateDir, "codex-tui.pid");
  }
  get codexAppServerPidFile() {
    return join(this.stateDir, "codex-app-server.pid");
  }
  get lockFile() {
    return join(this.stateDir, "daemon.lock");
  }
  get statusFile() {
    return join(this.stateDir, "status.json");
  }
  get portsFile() {
    return join(this.stateDir, "ports.json");
  }
  get logFile() {
    return join(this.stateDir, "agentbridge.log");
  }
  get codexWrapperLogFile() {
    return join(this.stateDir, "codex-wrapper.log");
  }
  get grokLeaderSocket() {
    return join(this.stateDir, "grok.sock");
  }
  get killedFile() {
    return join(this.stateDir, "killed");
  }
}

// src/log-rotator.ts
import { appendFileSync, statSync, renameSync, unlinkSync } from "fs";
var DEFAULT_MAX_BYTES = 50000000;
var DEFAULT_MAX_FILES = 3;
var MIN_MAX_BYTES = 1024;
var MIN_MAX_FILES = 1;
function parseEnvInt(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === "")
    return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min)
    return fallback;
  return n;
}

class RotatingLogger {
  path;
  bytesWritten = 0;
  maxBytes;
  maxFiles;
  constructor(path, opts = {}) {
    this.path = path;
    this.maxBytes = opts.maxBytes ?? parseEnvInt("AGENTBRIDGE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES, MIN_MAX_BYTES);
    this.maxFiles = opts.maxFiles ?? parseEnvInt("AGENTBRIDGE_LOG_MAX_FILES", DEFAULT_MAX_FILES, MIN_MAX_FILES);
    this.seed();
  }
  write(line) {
    try {
      const bytes = Buffer.byteLength(line, "utf8");
      if (this.bytesWritten + bytes > this.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.path, line);
      this.bytesWritten += bytes;
    } catch {}
  }
  rotate() {
    try {
      const oldest = this.generationPath(this.maxFiles);
      this.silentUnlink(oldest);
      for (let i = this.maxFiles - 1;i >= 1; i--) {
        this.silentRename(this.generationPath(i), this.generationPath(i + 1));
      }
      this.silentRename(this.path, this.generationPath(1));
      this.bytesWritten = 0;
    } catch {}
  }
  getBytesWritten() {
    return this.bytesWritten;
  }
  seed() {
    try {
      const st = statSync(this.path);
      if (st.size > this.maxBytes) {
        this.bytesWritten = st.size;
        this.rotate();
      } else {
        this.bytesWritten = st.size;
      }
    } catch {
      this.bytesWritten = 0;
    }
  }
  generationPath(n) {
    return `${this.path}.${n}`;
  }
  silentRename(from, to) {
    try {
      renameSync(from, to);
    } catch {}
  }
  silentUnlink(p) {
    try {
      unlinkSync(p);
    } catch {}
  }
}
var cache = new Map;
function getRotatingLogger(path, opts) {
  let inst = cache.get(path);
  if (!inst) {
    inst = new RotatingLogger(path, opts);
    cache.set(path, inst);
  }
  return inst;
}

// src/app-server-protocol.ts
var APP_SERVER_TRACKED_REQUEST_METHODS = [
  "thread/start",
  "thread/resume",
  "turn/start"
];
var APP_SERVER_SERVER_REQUEST_METHODS = [
  "item/permissions/requestApproval",
  "item/fileChange/requestApproval",
  "item/commandExecution/requestApproval"
];
var APP_SERVER_NOTIFICATION_METHODS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/agentMessage/delta",
  "item/completed"
];
var TRACKED_REQUEST_METHOD_SET = new Set(APP_SERVER_TRACKED_REQUEST_METHODS);
var SERVER_REQUEST_METHOD_SET = new Set(APP_SERVER_SERVER_REQUEST_METHODS);
var NOTIFICATION_METHOD_SET = new Set(APP_SERVER_NOTIFICATION_METHODS);
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTrackedAppServerRequestMethod(method) {
  return typeof method === "string" && TRACKED_REQUEST_METHOD_SET.has(method);
}
function isAppServerRequestMessage(value) {
  if (!isObjectRecord(value))
    return false;
  return (typeof value.id === "number" || typeof value.id === "string") && typeof value.method === "string";
}
function isAppServerNotification(value) {
  if (!isObjectRecord(value))
    return false;
  return value.id === undefined && typeof value.method === "string" && NOTIFICATION_METHOD_SET.has(value.method);
}
function isAppServerResponseMessage(value) {
  if (!isObjectRecord(value))
    return false;
  return (typeof value.id === "number" || typeof value.id === "string") && value.method === undefined && (("result" in value) || ("error" in value));
}

// src/codex-adapter.ts
class CodexAdapter extends EventEmitter {
  static RESPONSE_TRACKING_TTL_MS = 30000;
  proc = null;
  appServerWs = null;
  tuiWs = null;
  proxyServer = null;
  threadId = null;
  nextInjectionId = -1;
  appPort;
  proxyPort;
  logFile;
  appServerPidFile;
  tuiConnId = 0;
  connIdCounter = 0;
  secondaryConnections = new Map;
  agentMessageBuffers = new Map;
  pendingRequests = new Map;
  activeTurnIds = new Set;
  turnInProgress = false;
  pendingTurnStarts = new Map;
  injectionCorrelations = new Map;
  static TURN_START_CONFIRM_TIMEOUT_MS = 15000;
  get turnPending() {
    return this.turnInProgress || this.pendingTurnStarts.size > 0;
  }
  nextProxyId = 1e5;
  upstreamToClient = new Map;
  serverRequestToProxy = new Map;
  pendingServerRequests = [];
  pendingServerResponses = new Map;
  staleProxyIds = new Map;
  bridgeRequestIds = new Map;
  intentionalDisconnect = false;
  pendingTuiMessages = [];
  reconnectingForNewSession = false;
  replayingBufferedMessages = false;
  appServerGeneration = 0;
  outageQueue = [];
  outageTimer = null;
  static OUTAGE_QUEUE_MAX = 64;
  static OUTAGE_TIMEOUT_MS = 5000;
  lastInitializeRaw = null;
  lastInitializedRaw = null;
  sessionRestoreInProgress = false;
  replayPending = new Map;
  static SESSION_REPLAY_TIMEOUT_MS = 5000;
  constructor(appPort = 4500, proxyPort = 4501, logFile = new StateDirResolver().logFile, appServerPidFile = new StateDirResolver().codexAppServerPidFile) {
    super();
    this.appPort = appPort;
    this.proxyPort = proxyPort;
    this.logFile = logFile;
    this.appServerPidFile = appServerPidFile;
  }
  get appServerUrl() {
    return `ws://127.0.0.1:${this.appPort}`;
  }
  get proxyUrl() {
    return `ws://127.0.0.1:${this.proxyPort}`;
  }
  get activeThreadId() {
    return this.threadId;
  }
  async start() {
    this.intentionalDisconnect = false;
    await this.checkPorts();
    this.log(`Spawning codex app-server on ${this.appServerUrl}`);
    this.proc = spawn("codex", ["app-server", "--listen", this.appServerUrl], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.recordAppServerPid(this.proc.pid ?? null);
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => {
      this.clearAppServerPid();
      this.emit("exit", code);
    });
    const stderrRl = createInterface({ input: this.proc.stderr });
    stderrRl.on("line", (l) => this.log(`[codex-server] ${l}`));
    const stdoutRl = createInterface({ input: this.proc.stdout });
    stdoutRl.on("line", (l) => this.log(`[codex-stdout] ${l}`));
    await this.waitForHealthy();
    await this.connectToAppServer();
    this.startProxy();
    this.log(`Proxy ready on ${this.proxyUrl}`);
  }
  disconnect() {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outageQueue = [];
    this.clearOutageTimer();
    this.appServerWs?.close();
    this.appServerWs = null;
    for (const [id, sec] of this.secondaryConnections) {
      try {
        sec.appServerWs?.close();
      } catch {}
      this.secondaryConnections.delete(id);
    }
    this.proxyServer?.stop();
    this.proxyServer = null;
    this.clearResponseTrackingState();
  }
  stop() {
    this.intentionalDisconnect = true;
    this.disconnect();
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
      proc.on("exit", () => clearTimeout(killTimer));
    }
  }
  injectMessage(text, correlation) {
    if (!this.threadId) {
      this.log("Cannot inject: no active thread");
      return false;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("Cannot inject: app-server WebSocket not connected");
      return false;
    }
    if (this.turnPending) {
      this.log(this.turnInProgress ? `Rejected injection: Codex turn is in progress (thread ${this.threadId})` : `Rejected injection: a turn/start is already in flight (thread ${this.threadId})`);
      return false;
    }
    this.log(`Injecting message into Codex (${text.length} chars)`);
    const requestId = this.nextInjectionId--;
    this.trackBridgeRequestId(requestId);
    try {
      this.appServerWs.send(JSON.stringify({
        method: "turn/start",
        id: requestId,
        params: { threadId: this.threadId, input: [{ type: "text", text }] }
      }));
      this.reserveTurnStart(requestId);
      if (correlation)
        this.injectionCorrelations.set(requestId, correlation);
      return true;
    } catch (err) {
      this.untrackBridgeRequestId(requestId);
      this.log(`Injection send failed: ${err.message}`);
      return false;
    }
  }
  async waitForHealthy(maxRetries = 20, delayMs = 500) {
    for (let i = 0;i < maxRetries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.appPort}/healthz`);
        if (res.ok)
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Codex app-server failed to become healthy");
  }
  connectToAppServer(isReconnect = false) {
    const generation = ++this.appServerGeneration;
    return new Promise((resolve, reject) => {
      const appWs = new WebSocket(this.appServerUrl);
      appWs.onopen = () => {
        if (this.appServerGeneration !== generation) {
          appWs.close();
          return;
        }
        this.appServerWs = appWs;
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        this.log(isReconnect ? "Reconnected to app-server" : "Connected to app-server");
        this.flushPendingServerResponses();
        if (isReconnect) {
          this.handleSessionRestoreAfterReconnect().finally(() => this.drainOutageQueue()).catch((e) => {
            const m = e instanceof Error ? e.message : String(e);
            this.log(`session restore unexpected error: ${m}`);
          });
        } else {
          this.drainOutageQueue();
        }
        resolve();
      };
      appWs.onmessage = (event) => {
        if (this.appServerGeneration !== generation)
          return;
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        const forwarded = this.handleAppServerPayload(data);
        if (forwarded === null)
          return;
        if (this.tuiWs) {
          try {
            this.tuiWs.send(forwarded);
          } catch (e) {
            this.log(`Failed to forward message to TUI: ${e.message}`);
          }
        } else {
          this.log("WARNING: response from app-server but no TUI connected, message dropped");
        }
      };
      appWs.onerror = () => {
        if (this.appServerGeneration !== generation)
          return;
        this.log("App-server connection error");
        if (!isReconnect)
          reject(new Error("Failed to connect to app-server"));
      };
      appWs.onclose = () => {
        if (this.appServerGeneration !== generation)
          return;
        this.handleAppServerClose();
      };
    });
  }
  async reconnectAppServerForNewSession(tuiWs) {
    this.appServerGeneration++;
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const oldWs = this.appServerWs;
    this.appServerWs = null;
    if (oldWs) {
      try {
        oldWs.close();
      } catch {}
    }
    this.clearResponseTrackingStateForAppServerReconnect();
    this.abandonTurns("the app-server was reconnected for a new TUI session");
    try {
      await this.connectToAppServer(false);
      this.log("App-server reconnected for new TUI session \u2014 replaying buffered messages");
      const messages = this.pendingTuiMessages;
      this.pendingTuiMessages = [];
      this.reconnectingForNewSession = false;
      this.replayingBufferedMessages = true;
      try {
        for (const msg of messages) {
          this.onTuiMessage(tuiWs, msg);
        }
      } finally {
        this.replayingBufferedMessages = false;
      }
    } catch (err) {
      this.log(`Failed to reconnect app-server for new session: ${err.message}`);
      this.pendingTuiMessages = [];
      this.reconnectingForNewSession = false;
      this.intentionalDisconnect = false;
      this.scheduleReconnect();
    }
  }
  reconnectAttempts = 0;
  reconnectTimer = null;
  static MAX_RECONNECT_ATTEMPTS = 10;
  static RECONNECT_BASE_DELAY_MS = 1000;
  scheduleReconnect() {
    if (!this.proc)
      return;
    if (this.reconnectAttempts >= CodexAdapter.MAX_RECONNECT_ATTEMPTS) {
      this.log(`App-server reconnect failed after ${this.reconnectAttempts} attempts. Giving up.`);
      this.emit("error", new Error("App-server connection lost and reconnect failed"));
      return;
    }
    const delay = Math.min(CodexAdapter.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.log(`Scheduling app-server reconnect attempt ${this.reconnectAttempts}/${CodexAdapter.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectToAppServer(true);
        this.log("App-server reconnect successful");
      } catch {
        this.log("App-server reconnect attempt failed");
        this.scheduleReconnect();
      }
    }, delay);
  }
  handleAppServerClose() {
    const intentional = this.intentionalDisconnect;
    const tuiConnected = this.tuiWs !== null;
    this.log(`App-server connection closed (intentional=${intentional}, tuiConnected=${tuiConnected}, turnInProgress=${this.turnInProgress})`);
    this.appServerWs = null;
    this.clearResponseTrackingState();
    this.abandonTurns("the app-server connection closed");
    if (!intentional) {
      this.scheduleReconnect();
    }
  }
  bufferDuringOutage(ws, raw) {
    if (this.outageQueue.length >= CodexAdapter.OUTAGE_QUEUE_MAX) {
      this.log(`ERROR: outage queue overflow (${this.outageQueue.length}/${CodexAdapter.OUTAGE_QUEUE_MAX}) \u2014 closing TUI with 1011`);
      this.outageQueue = [];
      this.clearOutageTimer();
      if (this.tuiWs && this.tuiWs === ws) {
        try {
          ws.close(1011, "agentbridge: app-server unavailable; pending TUI queue overflow");
        } catch (e) {
          this.log(`Failed to close TUI WS after outage queue overflow: ${e.message}`);
        }
      }
      return;
    }
    this.outageQueue.push({ raw, connId: ws.data.connId });
    this.log(`DIAGNOSTIC: buffered TUI message while app-server unavailable (queue size=${this.outageQueue.length}/${CodexAdapter.OUTAGE_QUEUE_MAX})`);
    this.ensureOutageTimer();
  }
  ensureOutageTimer() {
    if (this.outageTimer !== null)
      return;
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      const buffered = this.outageQueue.length;
      this.outageQueue = [];
      this.log(`ERROR: app-server did not return within ${CodexAdapter.OUTAGE_TIMEOUT_MS}ms (buffered=${buffered}) \u2014 closing TUI with 1011`);
      const ws = this.tuiWs;
      if (ws) {
        try {
          ws.close(1011, `agentbridge: app-server unavailable after ${CodexAdapter.OUTAGE_TIMEOUT_MS}ms; buffered=${buffered}`);
        } catch (e) {
          this.log(`Failed to close TUI WS on outage timeout: ${e.message}`);
        }
      }
    }, CodexAdapter.OUTAGE_TIMEOUT_MS);
  }
  clearOutageTimer() {
    if (this.outageTimer !== null) {
      clearTimeout(this.outageTimer);
      this.outageTimer = null;
    }
  }
  async handleSessionRestoreAfterReconnect() {
    if (!this.lastInitializeRaw) {
      this.log("DIAGNOSTIC: no cached initialize to replay after unintentional reconnect");
      return;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("DIAGNOSTIC: app-server not open at session restore start \u2014 skipping");
      return;
    }
    this.sessionRestoreInProgress = true;
    try {
      this.log(`DIAGNOSTIC: replaying cached initialize to restore session (threadId=${this.threadId ?? "none"})`);
      await this.sendReplayAndAwait(this.lastInitializeRaw, "initialize");
      if (this.lastInitializedRaw && this.appServerWs.readyState === WebSocket.OPEN) {
        this.appServerWs.send(this.lastInitializedRaw);
      }
      if (this.threadId && this.appServerWs.readyState === WebSocket.OPEN) {
        const replayId = `agentbridge-replay-thread-resume-${Date.now()}`;
        const resumeRaw = JSON.stringify({
          jsonrpc: "2.0",
          id: replayId,
          method: "thread/resume",
          params: { threadId: this.threadId }
        });
        await this.sendReplayAndAwait(resumeRaw, "thread/resume");
      }
      this.log(`DIAGNOSTIC: session restored after unintentional reconnect (threadId=${this.threadId ?? "none"})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`ERROR: session restore failed (${msg}) \u2014 closing TUI with 1011`);
      const tuiWs = this.tuiWs;
      if (tuiWs) {
        try {
          tuiWs.close(1011, `agentbridge: session restore failed: ${msg}`);
        } catch (closeErr) {
          const cm = closeErr instanceof Error ? closeErr.message : String(closeErr);
          this.log(`Failed to close TUI after session restore failure: ${cm}`);
        }
      }
    } finally {
      this.sessionRestoreInProgress = false;
    }
  }
  sendReplayAndAwait(raw, method) {
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server not open"));
    }
    let id;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.id === undefined) {
        return Promise.reject(new Error(`replay payload for ${method} has no id`));
      }
      id = parsed.id;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return Promise.reject(new Error(`replay parse failed for ${method}: ${m}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replayPending.delete(id);
        reject(new Error(`replay timeout (${CodexAdapter.SESSION_REPLAY_TIMEOUT_MS}ms) for ${method} id=${JSON.stringify(id)}`));
      }, CodexAdapter.SESSION_REPLAY_TIMEOUT_MS);
      this.replayPending.set(id, { method, resolve, reject, timer });
      try {
        this.appServerWs.send(raw);
      } catch (e) {
        clearTimeout(timer);
        this.replayPending.delete(id);
        const m = e instanceof Error ? e.message : String(e);
        reject(new Error(`replay send failed for ${method}: ${m}`));
      }
    });
  }
  tryConsumeReplayResponse(payload) {
    const id = payload.id;
    if (id === undefined)
      return false;
    const pending = this.replayPending.get(id);
    if (!pending)
      return false;
    clearTimeout(pending.timer);
    this.replayPending.delete(id);
    if (payload.error !== undefined) {
      const errMsg = typeof payload.error === "object" && payload.error !== null && "message" in payload.error ? String(payload.error.message ?? "unknown") : JSON.stringify(payload.error);
      pending.reject(new Error(`${pending.method} rejected: ${errMsg}`));
    } else {
      pending.resolve(payload);
    }
    return true;
  }
  drainOutageQueue() {
    if (this.outageQueue.length === 0) {
      this.clearOutageTimer();
      return;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN)
      return;
    const ws = this.tuiWs;
    if (!ws) {
      this.outageQueue = [];
      this.clearOutageTimer();
      return;
    }
    const messages = this.outageQueue;
    this.outageQueue = [];
    this.clearOutageTimer();
    this.log(`DIAGNOSTIC: replaying ${messages.length} buffered TUI messages after app-server reconnect`);
    for (const msg of messages) {
      try {
        this.onTuiMessage(ws, msg.raw);
      } catch (e) {
        this.log(`Failed to replay buffered TUI message (conn #${msg.connId}): ${e.message}`);
      }
    }
  }
  startProxy() {
    const self = this;
    this.proxyServer = Bun.serve({
      port: this.proxyPort,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
        self.log(`HTTP ${req.method} ${url.pathname} (upgrade=${isUpgrade})`);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return fetch(`http://127.0.0.1:${self.appPort}${url.pathname}`);
        }
        if (server.upgrade(req, { data: { connId: 0 } }))
          return;
        self.log(`WARNING: non-upgrade HTTP request not handled: ${req.method} ${url.pathname}`);
        return new Response("AgentBridge Codex Proxy");
      },
      websocket: {
        open: (ws) => self.onTuiConnect(ws),
        close: (ws, code, reason) => {
          self.log(`WebSocket close event: conn #${ws.data.connId}, code=${code}, reason=${reason || "none"}`);
          self.onTuiDisconnect(ws);
        },
        message: (ws, msg) => self.onTuiMessage(ws, msg)
      }
    });
  }
  onTuiConnect(ws) {
    const connId = ++this.connIdCounter;
    ws.data.connId = connId;
    if (this.tuiWs) {
      this.log(`Secondary TUI connected (conn #${connId}, primary is #${this.tuiConnId})`);
      this.setupSecondaryConnection(ws, connId);
      return;
    }
    const previousConnId = this.tuiConnId > 0 ? this.tuiConnId : null;
    this.tuiConnId = connId;
    this.tuiWs = ws;
    this.threadId = null;
    this.log(`TUI connected (conn #${this.tuiConnId})`);
    this.emit("tuiConnected", this.tuiConnId);
    if (previousConnId !== null) {
      this.retireConnectionState(previousConnId);
    }
  }
  setupSecondaryConnection(ws, connId) {
    const appWs = new WebSocket(this.appServerUrl);
    const entry = { tuiWs: ws, appServerWs: appWs, buffer: [] };
    this.secondaryConnections.set(connId, entry);
    appWs.onopen = () => {
      if (!this.secondaryConnections.has(connId)) {
        appWs.close();
        return;
      }
      this.log(`Secondary conn #${connId}: app-server WS connected, flushing ${entry.buffer.length} buffered messages`);
      for (const msg of entry.buffer) {
        try {
          appWs.send(msg);
        } catch {}
      }
      entry.buffer = [];
    };
    appWs.onmessage = (event) => {
      if (!this.secondaryConnections.has(connId))
        return;
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      try {
        ws.send(data);
      } catch {}
    };
    appWs.onerror = () => {
      this.log(`Secondary conn #${connId}: app-server WS error`);
    };
    appWs.onclose = () => {
      this.log(`Secondary conn #${connId}: app-server WS closed`);
      const sec = this.secondaryConnections.get(connId);
      if (sec) {
        this.secondaryConnections.delete(connId);
        try {
          sec.tuiWs.close();
        } catch {}
      }
    };
  }
  replayPendingForThread(resumedThreadId, ws) {
    const remaining = [];
    for (const buffered of this.pendingServerRequests) {
      const belongsToThread = buffered.threadId === null || buffered.threadId === resumedThreadId;
      if (!belongsToThread) {
        remaining.push(buffered);
        continue;
      }
      const proxyId = this.nextProxyId++;
      try {
        const parsed = JSON.parse(buffered.raw);
        parsed.id = proxyId;
        ws.send(JSON.stringify(parsed));
        this.serverRequestToProxy.set(proxyId, {
          raw: buffered.raw,
          serverId: buffered.serverId,
          connId: this.tuiConnId,
          method: buffered.method,
          timestamp: Date.now(),
          threadId: buffered.threadId
        });
        if (buffered.threadId === null) {
          this.log(`WARNING: Replaying pending server request with unknown threadId (experimental fallback, may surface orphan UI on wrong thread): ${buffered.method} (server id=${buffered.serverId} \u2192 proxy id=${proxyId})`);
        } else {
          this.log(`Replayed buffered server request on thread/resume: ${buffered.method} (server id=${buffered.serverId} \u2192 proxy id=${proxyId}, threadId=${buffered.threadId})`);
        }
      } catch (e) {
        this.log(`Failed to replay buffered server request: ${buffered.method} (server id=${buffered.serverId}): ${e.message}`);
        remaining.push(buffered);
      }
    }
    this.pendingServerRequests = remaining;
  }
  dropOrphanPendingRequests(reason, matchThreadId = null) {
    if (this.pendingServerRequests.length === 0)
      return;
    const remaining = [];
    for (const buffered of this.pendingServerRequests) {
      const shouldDrop = matchThreadId === null ? true : buffered.threadId !== null && buffered.threadId !== matchThreadId;
      if (shouldDrop) {
        this.log(`Dropped orphan pending server request: ${buffered.method} (server id=${buffered.serverId}, threadId=${buffered.threadId ?? "unknown"}, reason=${reason})`);
        continue;
      }
      remaining.push(buffered);
    }
    this.pendingServerRequests = remaining;
  }
  onTuiDisconnect(ws) {
    const connId = ws.data.connId;
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      this.log(`Secondary TUI disconnected (conn #${connId})`);
      this.secondaryConnections.delete(connId);
      if (secondary.appServerWs) {
        try {
          secondary.appServerWs.close();
        } catch {}
      }
      return;
    }
    if (this.tuiWs === ws) {
      const appServerOpen = this.appServerWs?.readyState === WebSocket.OPEN;
      this.log(`TUI disconnected (conn #${connId}, appServerOpen=${appServerOpen}, turnInProgress=${this.turnInProgress}, pendingTuiMessages=${this.pendingTuiMessages.length}, outageQueue=${this.outageQueue.length}, reconnectingForNewSession=${this.reconnectingForNewSession})`);
      this.tuiWs = null;
      if (this.reconnectingForNewSession) {
        this.log("Clearing pending TUI message buffer (TUI disconnected during app-server reconnect)");
        this.pendingTuiMessages = [];
        this.reconnectingForNewSession = false;
      }
      if (this.outageQueue.length > 0 || this.outageTimer !== null) {
        this.log(`Clearing outage queue on TUI disconnect (buffered=${this.outageQueue.length})`);
        this.outageQueue = [];
        this.clearOutageTimer();
      }
      this.emit("tuiDisconnected", connId);
    } else {
      this.log(`Stale TUI disconnected (conn #${connId}, current is #${this.tuiConnId})`);
    }
    this.retireConnectionState(connId);
  }
  onTuiMessage(ws, msg) {
    const data = typeof msg === "string" ? msg : msg.toString();
    const connId = ws.data.connId;
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      if (secondary.appServerWs && secondary.appServerWs.readyState === WebSocket.OPEN) {
        try {
          secondary.appServerWs.send(data);
        } catch {}
      } else {
        secondary.buffer.push(data);
      }
      return;
    }
    if (connId !== this.tuiConnId) {
      this.log(`Dropping message from stale TUI conn #${connId} (current is #${this.tuiConnId})`);
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (parsed.id !== undefined && !parsed.method) {
        const normalizedId = this.normalizeNumericId(parsed.id);
        if (!isNaN(normalizedId) && this.pendingServerResponses.has(normalizedId)) {
          this.log(`Ignoring duplicate approval response while app-server reconnect is pending (proxy id=${normalizedId})`);
          return;
        }
        const pending = !isNaN(normalizedId) ? this.serverRequestToProxy.get(normalizedId) : undefined;
        if (pending !== undefined) {
          if (pending.connId !== connId) {
            this.log(`Dropping stale server request response (proxy id=${normalizedId}, expected conn #${pending.connId}, got #${connId})`);
            return;
          }
          parsed.id = pending.serverId;
          const forwardedResponse = JSON.stringify(parsed);
          if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
            this.bufferPendingServerResponse(normalizedId, pending, forwardedResponse, "app-server disconnected");
            return;
          }
          try {
            this.appServerWs.send(forwardedResponse);
            this.serverRequestToProxy.delete(normalizedId);
            this.log(`TUI \u2192 app-server: ${pending.method} response (proxy id=${normalizedId} \u2192 server id=${pending.serverId})`);
          } catch (e) {
            this.bufferPendingServerResponse(normalizedId, pending, forwardedResponse, `send failed: ${e.message}`);
          }
          return;
        }
      }
    } catch {}
    let detectedMethod;
    try {
      const parsed = JSON.parse(data);
      detectedMethod = typeof parsed.method === "string" ? parsed.method : undefined;
    } catch {}
    if (!this.replayingBufferedMessages) {
      if (detectedMethod === "initialize") {
        this.lastInitializeRaw = data;
        this.log("Detected initialize \u2014 reconnecting app-server for fresh session");
        this.reconnectingForNewSession = true;
        this.pendingTuiMessages = [data];
        this.reconnectAppServerForNewSession(ws);
        return;
      }
      if (this.reconnectingForNewSession) {
        this.pendingTuiMessages.push(data);
        return;
      }
    }
    if (detectedMethod === "initialized") {
      this.lastInitializedRaw = data;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN || this.sessionRestoreInProgress) {
      if (this.tuiWs && this.tuiWs === ws) {
        this.bufferDuringOutage(ws, data);
      } else {
        this.log(`WARNING: non-primary TUI attempted to send while app-server down \u2014 dropped (connId=${connId})`);
      }
      return;
    }
    let forwarded = data;
    try {
      const parsed = JSON.parse(data);
      const method = parsed.method ?? `response:${parsed.id}`;
      this.log(`TUI \u2192 app-server: ${method}`);
      if (parsed.id !== undefined && parsed.method) {
        const proxyId = this.nextProxyId++;
        this.upstreamToClient.set(proxyId, { connId, clientId: parsed.id });
        this.trackPendingRequest(parsed, connId, proxyId);
        parsed.id = proxyId;
        forwarded = JSON.stringify(parsed);
      } else {
        this.trackPendingRequest(parsed, connId);
      }
    } catch {
      this.log(`TUI \u2192 app-server: (unparseable)`);
    }
    if (this.appServerWs?.readyState === WebSocket.OPEN) {
      this.appServerWs.send(forwarded);
    } else {
      this.log(`WARNING: app-server closed between OPEN check and send \u2014 message lost (connId=${ws.data.connId})`);
    }
  }
  handleAppServerPayload(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
        if (this.tryConsumeReplayResponse(parsed)) {
          return null;
        }
      }
      if (isAppServerNotification(parsed) || typeof parsed === "object" && parsed !== null && !("id" in parsed)) {
        const notificationLike = parsed;
        if (notificationLike.method === "thread/closed") {
          const params = notificationLike.params;
          const threadId = typeof params?.threadId === "string" ? params.threadId : "unknown";
          this.log(`DIAGNOSTIC: app-server emitted thread/closed (threadId=${threadId}) \u2014 TUI will exit(0) silently`);
        }
        const forwarded = this.patchResponse(notificationLike, raw);
        this.interceptServerMessage(notificationLike);
        return forwarded;
      }
      if (isAppServerRequestMessage(parsed)) {
        this.handleServerRequest(parsed, raw);
        return null;
      }
      if (isAppServerResponseMessage(parsed)) {
        return this.handleAppServerResponse(parsed, raw);
      }
      this.log(`Dropping unclassifiable app-server message: ${raw.slice(0, 100)}`);
      return null;
    } catch {
      return raw;
    }
  }
  handleServerRequest(parsed, raw) {
    const serverId = parsed.id;
    const method = parsed.method;
    const threadId = this.extractThreadIdFromParams(parsed.params);
    if (!this.tuiWs) {
      this.pendingServerRequests.push({ raw, serverId, method, threadId });
      this.log(`Server request buffered (no TUI): ${method} (server id=${serverId}, threadId=${threadId ?? "unknown"})`);
      return;
    }
    const proxyId = this.nextProxyId++;
    parsed.id = proxyId;
    try {
      this.tuiWs.send(JSON.stringify(parsed));
    } catch (e) {
      this.log(`Server request send failed, buffering: ${method} (server id=${serverId}): ${e.message}`);
      this.pendingServerRequests.push({ raw, serverId, method, threadId });
      return;
    }
    this.serverRequestToProxy.set(proxyId, {
      raw,
      serverId,
      connId: this.tuiConnId,
      method,
      timestamp: Date.now(),
      threadId
    });
    this.log(`Server request: ${method} (server id=${serverId} \u2192 proxy id=${proxyId}, conn #${this.tuiConnId}, threadId=${threadId ?? "unknown"})`);
  }
  extractThreadIdFromParams(params) {
    if (typeof params !== "object" || params === null)
      return null;
    const tid = params.threadId;
    return typeof tid === "string" && tid.length > 0 ? tid : null;
  }
  normalizeNumericId(id) {
    if (typeof id === "number")
      return id;
    if (typeof id === "string" && /^-?\d+$/.test(id))
      return Number(id);
    return NaN;
  }
  bufferPendingServerResponse(proxyId, pending, forwardedResponse, reason) {
    this.pendingServerResponses.set(proxyId, {
      raw: forwardedResponse,
      serverId: pending.serverId,
      method: pending.method,
      timestamp: Date.now()
    });
    this.serverRequestToProxy.delete(proxyId);
    this.log(`Buffered approval response until app-server reconnect (${reason}) (proxy id=${proxyId} \u2192 server id=${pending.serverId})`);
  }
  flushPendingServerResponses() {
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN)
      return;
    for (const [proxyId, pending] of this.pendingServerResponses.entries()) {
      try {
        this.appServerWs.send(pending.raw);
        this.pendingServerResponses.delete(proxyId);
        this.log(`Flushed buffered approval response after app-server reconnect (proxy id=${proxyId} \u2192 server id=${pending.serverId})`);
      } catch (e) {
        this.log(`Failed to flush buffered approval response (proxy id=${proxyId}): ${e.message}`);
        break;
      }
    }
  }
  handleAppServerResponse(parsed, raw) {
    const responseId = parsed.id;
    const numericId = this.normalizeNumericId(responseId);
    const mapping = !isNaN(numericId) ? this.upstreamToClient.get(numericId) : undefined;
    if (mapping) {
      this.upstreamToClient.delete(numericId);
      if (mapping.connId !== this.tuiConnId) {
        this.log(`Dropping stale response (upstream id ${responseId}, from conn #${mapping.connId}, current #${this.tuiConnId})`);
        return null;
      }
      parsed.id = mapping.clientId;
      this.log(`app-server \u2192 TUI: response (proxy id=${numericId} \u2192 client id=${String(mapping.clientId)}, conn #${mapping.connId})`);
      const forwarded = this.patchResponse(parsed, JSON.stringify(parsed));
      this.interceptServerMessage(parsed, mapping.connId);
      return forwarded;
    }
    if (!isNaN(numericId) && this.consumeBridgeRequestId(numericId)) {
      this.clearTrackedId(this.pendingTurnStarts, numericId);
      const correlation = this.injectionCorrelations.get(numericId);
      this.injectionCorrelations.delete(numericId);
      if (parsed.error) {
        const error = parsed.error.message ?? "unknown error";
        this.log(`Bridge-originated request failed (id ${responseId}): ${error}`);
        if (correlation)
          this.emit("injectionRejected", { correlation, error });
      } else {
        this.log(`Bridge-originated request completed (id ${responseId})`);
      }
      return null;
    }
    if (!isNaN(numericId) && this.consumeStaleProxyId(numericId)) {
      this.log(`Dropping stale response for retired upstream id ${responseId}`);
      return null;
    }
    this.log(`Dropping unmatched app-server response id ${String(responseId)}`);
    return null;
  }
  patchResponse(parsed, raw) {
    if (isAppServerResponseMessage(parsed) && parsed.error && parsed.id !== undefined) {
      const errMsg = parsed.error.message ?? "";
      if (errMsg.includes("rate limits") || errMsg.includes("rateLimits")) {
        this.log(`Patching rateLimits error \u2192 mock success (id: ${parsed.id})`);
        return JSON.stringify({
          id: parsed.id,
          result: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: null },
              secondary: null,
              credits: null,
              planType: null
            },
            rateLimitsByLimitId: null
          }
        });
      }
    }
    return raw;
  }
  interceptServerMessage(msg, connId) {
    this.handleTrackedResponse(msg, connId);
    if ("method" in msg && typeof msg.method === "string" && isAppServerNotification(msg)) {
      this.handleServerNotification(msg);
    }
  }
  handleServerNotification(msg) {
    const { method, params } = msg;
    switch (method) {
      case "turn/started":
        this.markTurnStarted(params?.turn?.id);
        break;
      case "item/started": {
        const item = params?.item;
        if (item?.type === "agentMessage")
          this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = params?.itemId;
        if (typeof itemId !== "string")
          break;
        const buf = this.agentMessageBuffers.get(itemId);
        if (buf && params?.delta)
          buf.push(params.delta);
        break;
      }
      case "item/completed": {
        const item = params?.item;
        if (item?.type === "agentMessage") {
          const content = this.extractContent(item);
          this.agentMessageBuffers.delete(item.id);
          if (content) {
            this.log(`Agent message completed (${content.length} chars)`);
            this.emit("agentMessage", {
              senderRef: item.id,
              content
            });
          }
        }
        break;
      }
      case "turn/completed": {
        const wasInProgress = this.turnInProgress;
        this.markTurnCompleted(params?.turn?.id);
        if (wasInProgress && !this.turnInProgress) {
          this.emit("turnCompleted");
        }
        break;
      }
    }
  }
  extractContent(item) {
    if (item.content?.length) {
      return item.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
    }
    return this.agentMessageBuffers.get(item.id)?.join("") ?? "";
  }
  pendingKey(rpcId, connId) {
    const base = this.requestKey(rpcId);
    if (!base)
      return null;
    return `${connId ?? this.tuiConnId}:${base}`;
  }
  trackPendingRequest(message, connId, _proxyId) {
    const rpcId = "id" in message ? message.id : undefined;
    const method = "method" in message && typeof message.method === "string" ? message.method : undefined;
    const key = this.pendingKey(rpcId, connId);
    if (!key || !isTrackedAppServerRequestMethod(method))
      return;
    const pending = { method };
    if (method === "turn/start") {
      const params = "params" in message && typeof message.params === "object" && message.params !== null ? message.params : undefined;
      const threadId = params?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        pending.threadId = threadId;
      }
    }
    if (this.pendingRequests.has(key)) {
      this.log(`WARNING: overwriting pending request for key ${key}`);
    }
    this.pendingRequests.set(key, pending);
  }
  handleTrackedResponse(message, connId) {
    const key = this.pendingKey(message?.id, connId);
    if (!key)
      return;
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      if (message?.result?.thread?.id) {
        this.log(`[track-resp] Unmatched response with thread.id=${message.result.thread.id}, key=${key}, pending keys=[${[...this.pendingRequests.keys()].join(",")}]`);
      }
      return;
    }
    this.pendingRequests.delete(key);
    if (message?.error) {
      this.log(`Tracked request failed (${pending.method}, id ${key}): ${message.error.message ?? "unknown error"}`);
      return;
    }
    switch (pending.method) {
      case "thread/start": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/start response ${key}`);
        }
        this.dropOrphanPendingRequests(`thread/start (new session)`);
        break;
      }
      case "thread/resume": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/resume response ${key}`);
          if (this.tuiWs) {
            this.replayPendingForThread(threadId, this.tuiWs);
          }
          this.dropOrphanPendingRequests(`thread/resume to ${threadId}`, threadId);
        }
        break;
      }
      case "turn/start":
        if (pending.threadId) {
          this.setActiveThreadId(pending.threadId, `turn/start response ${key}`);
        }
        break;
    }
  }
  setActiveThreadId(threadId, reason) {
    if (this.threadId === threadId)
      return;
    const previousThreadId = this.threadId;
    this.threadId = threadId;
    if (previousThreadId) {
      this.log(`Active thread changed: ${previousThreadId} \u2192 ${threadId} (${reason})`);
      return;
    }
    this.log(`Thread detected: ${threadId} (${reason})`);
    this.emit("ready", threadId);
  }
  reserveTurnStart(requestId) {
    this.clearTrackedId(this.pendingTurnStarts, requestId);
    const timer = setTimeout(() => {
      this.pendingTurnStarts.delete(requestId);
      this.log(`turn/start ${requestId} was never confirmed; releasing the injection slot`);
    }, CodexAdapter.TURN_START_CONFIRM_TIMEOUT_MS);
    timer.unref?.();
    this.pendingTurnStarts.set(requestId, timer);
  }
  clearPendingTurnStarts() {
    for (const timer of this.pendingTurnStarts.values())
      clearTimeout(timer);
    this.pendingTurnStarts.clear();
  }
  markTurnStarted(turnId) {
    this.clearPendingTurnStarts();
    const wasInProgress = this.turnInProgress;
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.add(turnId);
    } else {
      this.activeTurnIds.add(`unknown:${Date.now()}`);
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
    if (!wasInProgress && this.turnInProgress) {
      this.emit("turnStarted");
    }
  }
  abandonTurns(why) {
    this.activeTurnIds.clear();
    this.turnInProgress = false;
    this.log(`Abandoning any running Codex turn: ${why}`);
    this.emit("turnAborted", why);
  }
  markTurnCompleted(turnId) {
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.delete(turnId);
    } else {
      this.activeTurnIds.clear();
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
  }
  requestKey(id) {
    if (typeof id === "number" || typeof id === "string")
      return String(id);
    return null;
  }
  retireConnectionState(connId) {
    const prefix = `${connId}:`;
    for (const key of this.pendingRequests.keys()) {
      if (key.startsWith(prefix))
        this.pendingRequests.delete(key);
    }
    for (const [upId, mapping] of this.upstreamToClient.entries()) {
      if (mapping.connId !== connId)
        continue;
      this.upstreamToClient.delete(upId);
      this.trackStaleProxyId(upId);
    }
    const requeuedServerRequests = [];
    for (const [proxyId, pending] of this.serverRequestToProxy.entries()) {
      if (pending.connId === connId) {
        this.serverRequestToProxy.delete(proxyId);
        requeuedServerRequests.push({
          raw: pending.raw,
          serverId: pending.serverId,
          method: pending.method,
          threadId: pending.threadId
        });
        this.log(`Requeued in-flight server request after TUI disconnect (proxy id=${proxyId}, server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
      }
    }
    if (requeuedServerRequests.length === 0)
      return;
    this.pendingServerRequests.push(...requeuedServerRequests);
  }
  trackStaleProxyId(proxyId) {
    this.clearTrackedId(this.staleProxyIds, proxyId);
    const timer = setTimeout(() => {
      this.staleProxyIds.delete(proxyId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.staleProxyIds.set(proxyId, timer);
  }
  consumeStaleProxyId(proxyId) {
    return this.clearTrackedId(this.staleProxyIds, proxyId);
  }
  trackBridgeRequestId(requestId) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);
    const timer = setTimeout(() => {
      this.bridgeRequestIds.delete(requestId);
      this.injectionCorrelations.delete(requestId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.bridgeRequestIds.set(requestId, timer);
  }
  consumeBridgeRequestId(requestId) {
    return this.clearTrackedId(this.bridgeRequestIds, requestId);
  }
  untrackBridgeRequestId(requestId) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);
    this.injectionCorrelations.delete(requestId);
  }
  clearTrackedId(store, id) {
    const timer = store.get(id);
    if (!timer)
      return false;
    clearTimeout(timer);
    store.delete(id);
    return true;
  }
  clearTransientResponseTrackingState() {
    this.pendingRequests.clear();
    this.upstreamToClient.clear();
    for (const timer of this.staleProxyIds.values()) {
      clearTimeout(timer);
    }
    this.staleProxyIds.clear();
    for (const timer of this.bridgeRequestIds.values()) {
      clearTimeout(timer);
    }
    this.bridgeRequestIds.clear();
    this.injectionCorrelations.clear();
    this.clearPendingTurnStarts();
  }
  clearResponseTrackingState() {
    this.clearTransientResponseTrackingState();
    this.serverRequestToProxy.clear();
    this.pendingServerRequests = [];
    this.pendingServerResponses.clear();
  }
  clearResponseTrackingStateForAppServerReconnect() {
    this.clearTransientResponseTrackingState();
    for (const pending of this.serverRequestToProxy.values()) {
      this.pendingServerRequests.push({
        raw: pending.raw,
        serverId: pending.serverId,
        method: pending.method,
        threadId: pending.threadId
      });
      this.log(`Requeued in-flight server request on app-server reconnect (server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
    }
    this.serverRequestToProxy.clear();
    this.pendingServerResponses.clear();
  }
  static buildPortListenLsofCommand(port) {
    return `lsof -ti tcp:${port} -sTCP:LISTEN`;
  }
  recordAppServerPid(pid) {
    if (pid === null)
      return;
    try {
      writeFileSync(this.appServerPidFile, `${pid}
`);
    } catch (err) {
      this.log(`Could not record app-server pid: ${err?.message ?? err}`);
    }
  }
  clearAppServerPid() {
    try {
      rmSync(this.appServerPidFile, { force: true });
    } catch {}
  }
  readRecordedAppServerPid() {
    try {
      const pid = parseInt(readFileSync(this.appServerPidFile, "utf-8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  static classifyPortHolder(pid, cmdline, recordedPid) {
    const isCodexAppServer = cmdline.includes("codex") && cmdline.includes("app-server");
    if (!isCodexAppServer)
      return "foreign";
    return recordedPid !== null && pid === recordedPid ? "ours" : "foreign-codex";
  }
  async checkPorts() {
    const recordedPid = this.readRecordedAppServerPid();
    for (const port of [this.appPort, this.proxyPort]) {
      try {
        const pids = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
          encoding: "utf-8"
        }).trim();
        if (!pids)
          continue;
        const pidList = pids.split(`
`).map((p) => p.trim()).filter(Boolean);
        const staleCodexPids = [];
        const foreignCodexPids = [];
        const foreignPids = [];
        for (const raw of pidList) {
          const pid = parseInt(raw, 10);
          if (!Number.isFinite(pid) || pid <= 0)
            continue;
          let cmdline;
          try {
            cmdline = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf-8" }).trim();
          } catch {
            continue;
          }
          switch (CodexAdapter.classifyPortHolder(pid, cmdline, recordedPid)) {
            case "ours":
              staleCodexPids.push(pid);
              break;
            case "foreign-codex":
              foreignCodexPids.push(pid);
              break;
            default:
              foreignPids.push(pid);
              break;
          }
        }
        if (staleCodexPids.length > 0) {
          this.log(`Cleaning up stale codex app-server on port ${port}: PID(s) ${staleCodexPids.join(", ")}`);
          for (const pid of staleCodexPids) {
            try {
              process.kill(pid);
            } catch {}
          }
          this.clearAppServerPid();
          await new Promise((r) => setTimeout(r, 500));
        }
        if (foreignCodexPids.length > 0) {
          throw new Error(`Port ${port} is already in use by a codex app-server this project did not start: ` + `PID(s) ${foreignCodexPids.join(", ")}. This usually means another AgentBridge project ` + `derives the same ports as this one. Run \`abg doctor\` to confirm, or set ` + `${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} to move this project off the collision.`);
        }
        if (foreignPids.length > 0) {
          throw new Error(`Port ${port} is already in use by non-Codex process(es): PID(s) ${foreignPids.join(", ")}. ` + `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`);
        }
        try {
          const remaining = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
            encoding: "utf-8"
          }).trim();
          if (remaining) {
            throw new Error(`Port ${port} is still occupied (PID(s): ${remaining.replace(/\n/g, ", ")}) after cleanup. ` + `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`);
          }
        } catch (err) {
          if (err.message?.includes("Port"))
            throw err;
        }
      } catch (err) {
        if (err.message?.includes("Port") || err.message?.includes("non-Codex"))
          throw err;
      }
    }
  }
  log(msg) {
    const line = `[${new Date().toISOString()}] [CodexAdapter] ${msg}
`;
    process.stderr.write(line);
    getRotatingLogger(this.logFile).write(line);
  }
}

// src/grok-adapter.ts
import { EventEmitter as EventEmitter2 } from "events";
import { existsSync as existsSync2, unlinkSync as unlinkSync2 } from "fs";
import { connect, createServer } from "net";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

// src/grok-acp.ts
var GROK_ACP_PROTOCOL_VERSION = 1;
function asObject(frame) {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame))
    return null;
  return frame;
}
function isId(v) {
  return typeof v === "number" || typeof v === "string";
}
function isJsonRpcRequest(frame) {
  const f = asObject(frame);
  return f !== null && typeof f.method === "string" && isId(f.id);
}
function isJsonRpcResponse(frame) {
  const f = asObject(frame);
  return f !== null && f.method === undefined && isId(f.id) && (("result" in f) || ("error" in f));
}
function isJsonRpcNotification(frame) {
  const f = asObject(frame);
  return f !== null && typeof f.method === "string" && f.id === undefined;
}
function updateText(update) {
  const text = update?.content?.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

// src/grok-leader-protocol.ts
var MAX_FRAME_BYTES = 64 * 1024 * 1024;

class LeaderProtocolError extends Error {
}
function encodeLeaderFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
function encodeAcpFrame(message) {
  return encodeLeaderFrame({ type: "acp", payload: JSON.stringify(message) });
}
function readAcpFrame(frame) {
  if (typeof frame !== "object" || frame === null)
    return null;
  const { type, payload } = frame;
  if (type !== "acp" || typeof payload !== "string")
    return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
function registerFrame(clientType) {
  return encodeLeaderFrame({
    type: "register",
    client_type: clientType,
    mode: "stdio",
    capabilities: {
      yolo_mode: false,
      auto_mode: false,
      client_version: "agentbridge",
      code_nav_enabled: false,
      terminal: false,
      fs_read: false,
      fs_write: false
    }
  });
}

class LeaderFramer {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new LeaderProtocolError(`Leader frame claims ${length} bytes, above the ${MAX_FRAME_BYTES} limit`);
      }
      if (this.buffer.length < 4 + length)
        break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      try {
        frames.push(JSON.parse(body));
      } catch {}
    }
    return frames;
  }
}

// src/grok-adapter.ts
class GrokAdapter extends EventEmitter2 {
  server = null;
  tui = null;
  injector = null;
  sessionIdValue = null;
  turnActive = false;
  tuiTurnRequestId = null;
  chunks = [];
  turnSeq = 0;
  nextRequestId = 1;
  injectionCorrelations = new Map;
  ourPrompts = new Set;
  stopped = false;
  socketPath;
  upstreamPath;
  logFile;
  makeServer;
  makeUpstream;
  constructor(options) {
    super();
    this.socketPath = options.socketPath;
    this.upstreamPath = options.upstreamPath ?? defaultLeaderSocket();
    this.logFile = options.logFile ?? null;
    this.makeServer = options.createServer ?? (() => listenUnix(this.socketPath, (err) => this.log(`Cannot listen on ${this.socketPath}: ${describe(err)}`)));
    this.makeUpstream = options.createUpstream ?? (() => connectUnix(this.upstreamPath));
  }
  get proxySocketPath() {
    return this.socketPath;
  }
  get sessionId() {
    return this.sessionIdValue;
  }
  get turnPending() {
    return this.turnActive;
  }
  get tuiConnected() {
    return this.tui !== null;
  }
  start() {
    const server = this.makeServer();
    this.server = server;
    server.onConnection((client) => this.attachTui(client));
    this.log(`Listening for the Grok TUI on ${this.socketPath}`);
  }
  stop() {
    this.stopped = true;
    this.tui?.close();
    this.injector?.close();
    this.server?.close();
    this.tui = null;
    this.injector = null;
    this.server = null;
    this.sessionIdValue = null;
  }
  injectMessage(text, correlation) {
    const sessionId = this.sessionIdValue;
    if (sessionId === null) {
      this.log("Cannot inject: no Grok session to inject into");
      return false;
    }
    const injector = this.ensureInjector();
    if (injector === null)
      return false;
    const id = this.nextRequestId++;
    this.log(`Injecting message into Grok (${text.length} chars)`);
    if (correlation)
      this.injectionCorrelations.set(id, correlation);
    this.ourPrompts.add(id);
    try {
      injector.write(encodeAcpFrame({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] }
      }));
    } catch (err) {
      this.injectionCorrelations.delete(id);
      this.ourPrompts.delete(id);
      this.log(`Injection send failed: ${describe(err)}`);
      return false;
    }
    return true;
  }
  attachTui(client) {
    if (this.stopped) {
      client.close();
      return;
    }
    if (this.tui !== null) {
      this.log("Refusing a second Grok TUI on this project's leader socket");
      client.close();
      return;
    }
    let upstream;
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
    const fromTui = new LeaderFramer;
    const fromLeader = new LeaderFramer;
    client.onData((chunk) => {
      upstream.write(chunk);
      this.observe(fromTui, chunk, (acp) => this.observeFromTui(acp));
    });
    upstream.onData((chunk) => {
      client.write(chunk);
      this.observe(fromLeader, chunk, (acp) => this.observeFromLeader(acp));
    });
    const teardown = () => {
      if (this.tui !== client)
        return;
      this.tui = null;
      client.close();
      upstream.close();
      this.flush("the Grok TUI disconnected");
      this.sessionIdValue = null;
      this.log("Grok TUI disconnected");
      this.emit("tuiDisconnected");
    };
    client.onClose(teardown);
    upstream.onClose(teardown);
  }
  observe(framer, chunk, handle) {
    let frames;
    try {
      frames = framer.push(chunk);
    } catch (err) {
      this.log(`Stopped reading a leader stream: ${describe(err)}`);
      return;
    }
    for (const frame of frames) {
      const acp = readAcpFrame(frame);
      if (acp === null)
        continue;
      try {
        handle(acp);
      } catch (err) {
        this.log(`Failed to interpret a leader frame: ${describe(err)}`);
      }
    }
  }
  observeFromTui(acp) {
    if (!isJsonRpcRequest(acp))
      return;
    if (acp.method !== "session/prompt")
      return;
    const sessionId = readSessionId(acp.params);
    if (sessionId === null)
      return;
    this.bindSession(sessionId);
    this.tuiTurnRequestId = acp.id;
    this.beginTurn();
  }
  observeFromLeader(acp) {
    if (isJsonRpcResponse(acp)) {
      if (this.tuiTurnRequestId !== null && acp.id === this.tuiTurnRequestId) {
        this.tuiTurnRequestId = null;
        this.flush("the leader answered the TUI's prompt");
      }
      const created = readSessionId(acp.result);
      if (created !== null && this.sessionIdValue === null)
        this.bindSession(created);
      return;
    }
    if (!isJsonRpcNotification(acp))
      return;
    if (acp.method !== "session/update")
      return;
    const params = acp.params;
    if (this.sessionIdValue === null || params?.sessionId !== this.sessionIdValue)
      return;
    const update = params.update;
    const kind = update?.sessionUpdate;
    if (kind === "user_message_chunk") {
      this.flush("a user message started a new turn");
      return;
    }
    if (kind !== "agent_message_chunk")
      return;
    const text = updateText(update);
    if (text === null)
      return;
    this.beginTurn();
    this.chunks.push(text);
  }
  ensureInjector() {
    if (this.injector !== null)
      return this.injector;
    let conn;
    try {
      conn = this.makeUpstream();
    } catch (err) {
      this.log(`Cannot open an injection connection to the leader: ${describe(err)}`);
      return null;
    }
    const framer = new LeaderFramer;
    conn.onData((chunk) => this.observe(framer, chunk, (acp) => this.observeInjectorReply(acp)));
    conn.onClose(() => {
      if (this.injector === conn)
        this.injector = null;
      this.log("Injection connection to the leader closed");
      this.failInflightInjections("the bridge's connection to the Grok leader closed before the prompt was answered");
    });
    try {
      conn.write(registerFrame("agentbridge (bus injector)"));
      conn.write(encodeAcpFrame({
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "initialize",
        params: {
          protocolVersion: GROK_ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        }
      }));
    } catch (err) {
      this.log(`Injection handshake failed: ${describe(err)}`);
      conn.close();
      return null;
    }
    this.injector = conn;
    return conn;
  }
  observeInjectorReply(acp) {
    if (!isJsonRpcResponse(acp))
      return;
    if (typeof acp.id !== "number" || !this.ourPrompts.has(acp.id))
      return;
    this.ourPrompts.delete(acp.id);
    const correlation = this.injectionCorrelations.get(acp.id) ?? null;
    this.injectionCorrelations.delete(acp.id);
    if (!acp.error) {
      this.flush("the leader answered our injected prompt", correlation);
      return;
    }
    const reason = acp.error.message || "Grok refused the prompt";
    this.log(`Injection rejected: ${reason}`);
    if (correlation) {
      this.emit("injectionRejected", { ...correlation, reason });
    }
  }
  failInflightInjections(reason) {
    if (this.ourPrompts.size === 0)
      return;
    this.log(`Failing ${this.ourPrompts.size} in-flight injection(s): ${reason}`);
    const inflight = [...this.ourPrompts];
    this.ourPrompts.clear();
    for (const id of inflight) {
      const correlation = this.injectionCorrelations.get(id);
      this.injectionCorrelations.delete(id);
      if (correlation) {
        this.emit("injectionRejected", { ...correlation, reason });
      }
    }
  }
  bindSession(sessionId) {
    if (this.sessionIdValue === sessionId)
      return;
    this.sessionIdValue = sessionId;
    this.log(`Attached to Grok session ${sessionId}`);
    this.emit("sessionAttached", sessionId);
  }
  beginTurn() {
    if (this.turnActive)
      return;
    this.turnActive = true;
    this.turnSeq += 1;
    this.emit("turnStarted");
  }
  flush(reason, respondingTo = null) {
    if (!this.turnActive && this.chunks.length === 0)
      return;
    const content = this.chunks.join("");
    const senderRef = `${this.sessionIdValue ?? "grok"}#${this.turnSeq}`;
    this.chunks = [];
    this.turnActive = false;
    if (content.trim()) {
      this.log(`Grok message completed (${content.length} chars, ${reason})`);
      this.emit("agentMessage", { senderRef, content, respondingTo });
    }
    this.emit("turnCompleted");
  }
  log(msg) {
    const line = `[${new Date().toISOString()}] [GrokAdapter] ${msg}
`;
    process.stderr.write(line);
    if (this.logFile)
      getRotatingLogger(this.logFile).write(line);
  }
}
function defaultLeaderSocket() {
  return join2(homedir2(), ".grok", "leader.sock");
}
function readSessionId(params) {
  if (typeof params !== "object" || params === null)
    return null;
  const id = params.sessionId;
  return typeof id === "string" ? id : null;
}
function wrapSocket(socket) {
  return {
    write(data) {
      socket.write(data);
    },
    onData(cb) {
      socket.on("data", (chunk) => cb(chunk));
    },
    onClose(cb) {
      socket.on("close", cb);
      socket.on("error", () => {});
    },
    close() {
      socket.destroy();
    }
  };
}
function connectUnix(path) {
  return wrapSocket(connect(path));
}
function listenUnix(path, onError) {
  if (existsSync2(path)) {
    try {
      unlinkSync2(path);
    } catch {}
  }
  const server = createServer();
  server.listen(path);
  server.on("error", onError);
  return {
    onConnection(cb) {
      server.on("connection", (socket) => cb(wrapSocket(socket)));
    },
    close() {
      server.close();
      try {
        if (existsSync2(path))
          unlinkSync2(path);
      } catch {}
    }
  };
}
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}

// src/status-line-writer.ts
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, existsSync as existsSync3 } from "fs";
import { dirname, join as join3 } from "path";
class StatusLineWriter {
  path;
  constructor(stateDir) {
    const dir = (stateDir ?? new StateDirResolver).dir;
    this.path = join3(dir, "status.line");
  }
  get filePath() {
    return this.path;
  }
  write(tag) {
    try {
      this.ensureDir();
      const oneLine = tag.replace(/[\r\n]+/g, " ").trim();
      writeFileSync2(this.path, `${oneLine}
`, "utf-8");
    } catch {}
  }
  clear() {
    try {
      this.ensureDir();
      writeFileSync2(this.path, "", "utf-8");
    } catch {}
  }
  ensureDir() {
    const dir = dirname(this.path);
    if (!existsSync3(dir)) {
      mkdirSync2(dir, { recursive: true });
    }
  }
}

// src/lifecycle-tags.ts
var C_RESET = "\x1B[0m";
var C_GREEN = "\x1B[32m";
var C_YELLOW = "\x1B[33m";
var C_RED = "\x1B[31m";
var C_DIM = "\x1B[2m";
var wrap = (c, s) => `${c}${s}${C_RESET}`;
var BRIDGE_STOPPED_TAG = wrap(C_DIM, "[BRIDGE STOPPED]");
var LIFECYCLE_TAGS = {
  system_tui_kickoff: wrap(C_GREEN, "[CODEX READY]"),
  system_daemon_disconnected: wrap(C_RED, "[BRIDGE OFFLINE]"),
  system_daemon_reconnected: wrap(C_GREEN, "[CODEX READY]"),
  system_bridge_ready: wrap(C_GREEN, "[BRIDGE READY]"),
  system_daemon_connect_failed: wrap(C_RED, "[BRIDGE FAILED]"),
  system_bridge_evicted: wrap(C_RED, "[REPLACED BY NEWER SESSION]"),
  system_bridge_probe_in_progress: wrap(C_YELLOW, "[RECONNECTING]"),
  system_bridge_replaced: wrap(C_RED, "[ANOTHER SESSION ACTIVE]"),
  system_bridge_project_mismatch: wrap(C_RED, "[PORT COLLISION]"),
  system_bridge_unknown_agent: wrap(C_RED, "[UNKNOWN AGENT]"),
  system_bridge_disabled: BRIDGE_STOPPED_TAG,
  system_bridge_auto_recovery_gave_up: wrap(C_RED, "[RECONNECT FAILED]"),
  system_bridge_recovered: wrap(C_GREEN, "[CODEX READY]"),
  system_ready: wrap(C_GREEN, "[CODEX READY]"),
  system_waiting: wrap(C_YELLOW, "[WAITING FOR CODEX]"),
  system_codex_start_failed: wrap(C_RED, "[CODEX FAILED]"),
  system_turn_started: wrap(C_YELLOW, "[CODEX THINKING]"),
  system_turn_completed: wrap(C_GREEN, "[CODEX READY]"),
  system_tui_disconnected: wrap(C_YELLOW, "[CODEX UI OFFLINE]"),
  system_tui_reconnected: wrap(C_GREEN, "[CODEX READY]")
};
var DAEMON_LIFECYCLE_IDS = new Set([
  "system_ready",
  "system_waiting",
  "system_codex_start_failed",
  "system_turn_started",
  "system_turn_completed",
  "system_tui_disconnected",
  "system_tui_reconnected"
]);

// src/agent-id.ts
var AGENT_IDS = ["claude", "grok", "codex"];
function isAgentId(v) {
  return typeof v === "string" && AGENT_IDS.includes(v);
}
function parseAgentId(v) {
  return isAgentId(v) ? v : null;
}
function agentLabel(agent) {
  return { claude: "Claude", grok: "Grok", codex: "Codex" }[agent];
}

// src/message-filter.ts
class MarkerError extends Error {
}
var MARKER_REGEX = /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)(?:\s+@([a-z][a-z0-9_-]*))?\]\s*/i;
function parseMarker(content) {
  const match = content.match(MARKER_REGEX);
  if (!match)
    return { marker: "untagged", to: null, body: content };
  const raw = match[1].toLowerCase();
  const marker = raw === "important" ? "reply" : raw;
  let to = null;
  if (match[2] !== undefined) {
    to = parseAgentId(match[2].toLowerCase());
    if (to === null) {
      throw new MarkerError(`Unknown address "@${match[2]}". Known agents: claude, grok, codex.`);
    }
  }
  return { marker, to, body: content.slice(match[0].length) };
}
function classifyMessage(content, mode) {
  const { marker } = parseMarker(content);
  if (mode === "full")
    return { action: "forward", marker };
  switch (marker) {
    case "reply":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      return { action: "queue", marker };
  }
}
var BRIDGE_CONTRACT_REMINDER = `[Bridge Contract] Markers tell the bridge whether to push your message to Claude immediately or let it sit in Claude's pull queue. Put the marker as the FIRST text in the message:

- [REPLY] - you actually have something to say to Claude as a peer (a proposal, a disagreement, a completion report, a blocker, an answer to a direct question). Pushed to Claude immediately, interrupts whatever Claude is doing.
- [STATUS] - progress update for the running task. Buffered + summarized; Claude sees the summary, not each one.
- [FYI] - background context. Delivered as low-priority: it reaches Claude, but it is the first thing shed if Claude's queue fills up, and Claude is told when that happens. Not a silent scratchpad \u2014 do not use it for notes you do not want read.
- (no marker) - queued. Claude only sees it when they call get_messages. Use this for routine output you don't need Claude to react to.

When to use [REPLY] (peer-to-peer rule of thumb):
- USE [REPLY] when: Claude asked you a direct question, you finished a task Claude is waiting on, you found something Claude needs to decide about, you disagree with Claude's plan, you hit a blocker only Claude can resolve.
- DO NOT use [REPLY] for: "ok", "received", "got it", routine progress, status pings, exploratory thinking, internal reasoning, file listings, anything you'd say to yourself. Those belong in [STATUS] or no marker.
- Think "would a human teammate Slack me about this RIGHT NOW?" If no, don't use [REPLY].

The marker MUST be the first text in the message (e.g. "[REPLY] Task done", not "Task done [REPLY]"). Keep agentMessage for high-value communication only.

[Cross-agent message style: ULTRA-TERSE]
Every agentMessage that reaches Claude costs tokens on Claude's side. Write at caveman-ultra level - just enough for Claude to understand, nothing more.
- Drop articles, filler, pleasantries.
- Fragments OK. Pattern: "[thing] [action] [reason]. [next step]."
- Abbreviate prose words: DB, auth, config, req, res, fn, impl, var, env, repo, PR, msg, ack, fwd. NEVER abbreviate code symbols, function names, file paths, error strings, commit hashes.
- Arrows for causality: X -> Y.
- Code blocks verbatim. Error strings quoted exact.
- One word when one word is enough.
- DROP this style for: security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread.
Bad: "I have finished the task, all tests are passing now."
Good: "[REPLY] done. bun test src 354 pass 0 fail."

[Git Operations \u2014 FORBIDDEN]
You MUST NOT execute any git write commands. This includes but is not limited to:
git commit, git push, git pull, git fetch, git checkout -b, git branch, git merge, git rebase, git cherry-pick, git tag, git stash.
These commands write to the .git directory, which is blocked by your sandbox. Attempting them will cause your session to hang indefinitely.
Read-only git commands (git status, git log, git diff, git show, git rev-parse) are allowed.
All git write operations must be delegated to Claude Code via agentMessage. Report what you changed and let Claude handle branching, committing, and pushing.

[Role Guidance for Codex]
- Your role: Advisor / Reviewer. Claude is the Executor (writes code, runs tools, handles git, ships changes). Your job is to make Claude's next move better, not to take over the implementation.
- Review Claude's plans / diffs / designs with an opinionated take. Spot bugs, name risks, propose sharper versions.
- Verify what Claude cannot observe themselves: reproduce sandbox-only behavior and report findings.
- Challenge with evidence when you disagree - disagreement is more useful than agreement.
- Do NOT run multi-step refactors or attempt to ship anything yourself. If a change needs to land in the repo, hand the spec back to Claude.
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"

[Review framing: do NOT anchor on Claude's frame]
Claude wrote the code. They already optimized for local correctness. They will (often unconsciously) frame the ask as "is each piece correct?". You will share that frame by default and miss the systemic problem. Run review in this order:
1. Local correctness (the obvious pass).
2. Single source of truth: any rule duplicated across files? Of those, which encode the same decision (must agree)? For each, is it production-defining (serving / auth / billing / access control)? If yes, "functionally identical today" is NOT safe - drift is the failure mode. Flag it as correctness, not style.
3. Fresh-eyes pass: ignore Claude's framing. What would a brand-new reviewer say is the wrong SHAPE here?
4. Author blind-spot: where did Claude likely normalize their own structure? Look for things Claude did NOT mention but should have.
If pass 2 finds duplication of a production-defining rule, flag it with [REPLY] even when Claude only asked for correctness. That is exactly the case where Claude is blind. "I treated duplication as acceptable because Claude already audited per-copy" is the failure this rule exists to prevent.`;
var REPLY_REQUIRED_INSTRUCTION = `

[\u26A0\uFE0F REPLY REQUIRED] Claude has explicitly requested a reply. You MUST send an agentMessage with the [REPLY] marker containing your response. This is a mandatory requirement - do not skip or use [STATUS]/[FYI] markers for this reply.`;
class StatusBuffer {
  onFlush;
  buffer = [];
  flushTimer = null;
  flushThreshold;
  flushTimeoutMs;
  paused = false;
  constructor(onFlush, options) {
    this.onFlush = onFlush;
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
  }
  get size() {
    return this.buffer.length;
  }
  pause() {
    this.paused = true;
    this.clearTimer();
  }
  resume() {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }
  add(message) {
    this.buffer.push(message);
    if (this.paused)
      return;
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }
  flush(reason) {
    if (this.buffer.length === 0)
      return;
    this.clearTimer();
    const combined = this.buffer.map((m) => parseMarker(m.content).body).join(`
---
`);
    const summary = {
      id: `status_summary_${Date.now()}`,
      from: "system",
      to: null,
      kind: "status",
      content: `[STATUS summary \u2014 ${this.buffer.length} update(s), flushed: ${reason}]
${combined}`,
      timestamp: Date.now()
    };
    this.onFlush(summary);
    this.buffer = [];
  }
  dispose() {
    this.clearTimer();
    this.buffer = [];
  }
  clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
  resetTimer() {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}

// src/tui-connection-state.ts
class TuiConnectionState {
  options;
  bridgeReady = false;
  tuiConnected = false;
  disconnectNotificationShown = false;
  disconnectNotificationTimer = null;
  constructor(options) {
    this.options = options;
  }
  canReply() {
    if (!this.bridgeReady)
      return false;
    return this.tuiConnected || this.disconnectNotificationTimer !== null;
  }
  snapshot() {
    return {
      bridgeReady: this.bridgeReady,
      tuiConnected: this.tuiConnected,
      disconnectNotificationShown: this.disconnectNotificationShown,
      hasPendingDisconnectNotification: this.disconnectNotificationTimer !== null
    };
  }
  markBridgeReady() {
    this.bridgeReady = true;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("thread became ready");
  }
  handleTuiConnected(connId) {
    const reconnectingAfterNotice = this.disconnectNotificationShown && this.bridgeReady;
    this.tuiConnected = true;
    this.clearPendingDisconnectNotification(`TUI reconnected as conn #${connId}`);
    if (reconnectingAfterNotice) {
      this.disconnectNotificationShown = false;
      this.options.onReconnectAfterNotice(connId);
    }
  }
  handleTuiDisconnected(connId) {
    this.tuiConnected = false;
    if (!this.bridgeReady) {
      this.options.log?.(`Suppressing pre-ready TUI disconnect notification (conn #${connId})`);
      return;
    }
    this.scheduleDisconnectNotification(connId);
  }
  handleCodexExit() {
    this.bridgeReady = false;
    this.tuiConnected = false;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("Codex process exited");
  }
  dispose(reason = "disposed") {
    this.clearPendingDisconnectNotification(reason);
  }
  clearPendingDisconnectNotification(reason) {
    if (!this.disconnectNotificationTimer)
      return;
    clearTimeout(this.disconnectNotificationTimer);
    this.disconnectNotificationTimer = null;
    if (reason) {
      this.options.log?.(`Cleared pending TUI disconnect notification (${reason})`);
    }
  }
  scheduleDisconnectNotification(connId) {
    this.clearPendingDisconnectNotification("rescheduled");
    this.disconnectNotificationTimer = setTimeout(() => {
      this.disconnectNotificationTimer = null;
      if (this.tuiConnected) {
        this.options.log?.(`Skipping TUI disconnect notification for conn #${connId} because TUI already reconnected`);
        return;
      }
      this.disconnectNotificationShown = true;
      this.options.log?.(`Codex TUI disconnect persisted past grace window (conn #${connId})`);
      this.options.onDisconnectPersisted(connId);
    }, this.options.disconnectGraceMs);
  }
}

// src/daemon-lifecycle.ts
import { spawn as spawn2, execFileSync as execFileSync2 } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3, openSync, closeSync, constants } from "fs";
import { fileURLToPath } from "url";

// src/port-preflight.ts
import { connect as connect2 } from "net";
var PROBE_TIMEOUT_MS = 1500;
var CONNECT_TIMEOUT_MS = 500;
function isPortListening(port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect2({ port, host: "127.0.0.1" });
    const done = (answer) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
async function probeControlPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (response.ok) {
      const body = await response.json();
      if (body && typeof body === "object" && "proxyUrl" in body) {
        return {
          kind: "agentbridge",
          projectId: "projectId" in body ? body.projectId ?? null : undefined,
          pid: typeof body.pid === "number" ? body.pid : null
        };
      }
    }
    return { kind: "unknown" };
  } catch {
    return await isPortListening(port) ? { kind: "unknown" } : { kind: "free" };
  }
}
function describeControlPortConflict(port, selfProjectId, holder) {
  const move = `Set AGENTBRIDGE_CONTROL_PORT to move this project off the collision, ` + `or run \`abg kill\` in the other project.`;
  if (holder.kind === "agentbridge") {
    const other = holder.projectId === undefined ? "an older AgentBridge daemon that does not report its project" : holder.projectId === null ? "an AgentBridge daemon running outside any project" : `the AgentBridge daemon of project ${holder.projectId}`;
    const self = selfProjectId ? `Project ${selfProjectId}` : "This project";
    return `Control port ${port} is already held by ${other}` + `${holder.pid !== null ? ` (pid ${holder.pid})` : ""}.
` + `${self} derives the same port slot \u2014 project ids hash into 1000 slots, so this happens.
` + `Run \`abg doctor\` to see both projects. ${move}`;
  }
  return `Control port ${port} is already in use by a process that is not an AgentBridge daemon.
` + `Stop whatever is listening on it, or ${move.charAt(0).toLowerCase()}${move.slice(1)}`;
}

// src/daemon-lifecycle.ts
function resolveDaemonPath() {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) {
    return fileURLToPath(new URL(process.env.AGENTBRIDGE_DAEMON_ENTRY, import.meta.url));
  }
  const candidates = [
    "./daemon.js",
    "../plugins/agentbridge/server/daemon.js",
    "./daemon.ts"
  ];
  for (const rel of candidates) {
    const abs = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync4(abs))
      return abs;
  }
  return fileURLToPath(new URL("./daemon.ts", import.meta.url));
}
var DAEMON_PATH = resolveDaemonPath();
var PROBE_TIMEOUT_MS2 = 1500;

class DaemonLifecycle {
  stateDir;
  controlPort;
  log;
  projectId;
  reportedForeignDaemon = false;
  constructor(opts) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
    this.projectId = opts.projectId !== undefined ? opts.projectId : process.env.AGENTBRIDGE_PROJECT_ID ?? null;
  }
  get healthUrl() {
    return `http://127.0.0.1:${this.controlPort}/healthz`;
  }
  get readyUrl() {
    return `http://127.0.0.1:${this.controlPort}/readyz`;
  }
  get controlWsUrl() {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }
  async ensureRunning() {
    if (await this.isHealthy()) {
      await this.waitForReady();
      return;
    }
    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForReady(12, 250);
            return;
          } catch {
            throw new Error(`Found existing daemon process ${existingPid}, but control port ${this.controlPort} never became ready.`);
          }
        }
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removeStalePidFile();
    }
    const lockAcquired = this.acquireLock();
    if (!lockAcquired) {
      this.log("Another process is starting the daemon, waiting for readiness...");
      await this.waitForReady();
      return;
    }
    try {
      const holder = await probeControlPort(this.controlPort);
      if (holder.kind !== "free") {
        throw new Error(describeControlPortConflict(this.controlPort, this.projectId, holder));
      }
      this.launch();
      await this.waitForReady();
    } finally {
      this.releaseLock();
    }
  }
  async isHealthy() {
    const probe = await this.probe(this.healthUrl);
    return probe !== null && probe.ok && this.acceptsDaemon(probe.body);
  }
  async probe(url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS2) });
      let body = null;
      try {
        body = await response.json();
      } catch {}
      return { ok: response.ok, body };
    } catch {
      return null;
    }
  }
  acceptsDaemon(body) {
    const reported = body && typeof body === "object" && "projectId" in body ? body.projectId ?? null : undefined;
    if (DaemonLifecycle.identityMatches(this.projectId, reported))
      return true;
    if (!this.reportedForeignDaemon) {
      this.reportedForeignDaemon = true;
      this.log(`Control port ${this.controlPort} is held by the daemon of project ${reported} ` + `(this project is ${this.projectId}). Not attaching to it. ` + `Run \`abg doctor\` \u2014 two projects derive the same port slot.`);
    }
    return false;
  }
  static identityMatches(expected, reported) {
    if (expected === null)
      return true;
    if (reported === undefined)
      return true;
    return reported === expected;
  }
  async waitForHealthy(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0;attempt < maxRetries; attempt++) {
      if (await this.isHealthy())
        return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon health on ${this.healthUrl}`);
  }
  async isReady() {
    const probe = await this.probe(this.readyUrl);
    return probe !== null && probe.ok && this.acceptsDaemon(probe.body);
  }
  async waitForReady(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0;attempt < maxRetries; attempt++) {
      if (await this.isReady())
        return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon readiness on ${this.readyUrl}`);
  }
  readStatus() {
    try {
      const raw = readFileSync2(this.stateDir.statusFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  writeStatus(status) {
    this.stateDir.ensure();
    writeFileSync3(this.stateDir.statusFile, JSON.stringify(status, null, 2) + `
`, "utf-8");
  }
  readPid() {
    try {
      const raw = readFileSync2(this.stateDir.pidFile, "utf-8").trim();
      if (!raw)
        return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }
  writePid(pid) {
    this.stateDir.ensure();
    writeFileSync3(this.stateDir.pidFile, `${pid ?? process.pid}
`, "utf-8");
  }
  removePidFile() {
    try {
      unlinkSync3(this.stateDir.pidFile);
    } catch {}
  }
  removeStatusFile() {
    try {
      unlinkSync3(this.stateDir.statusFile);
    } catch {}
  }
  markKilled() {
    this.stateDir.ensure();
    writeFileSync3(this.stateDir.killedFile, `${Date.now()}
`, "utf-8");
  }
  clearKilled() {
    try {
      unlinkSync3(this.stateDir.killedFile);
    } catch {}
  }
  wasKilled() {
    return existsSync4(this.stateDir.killedFile);
  }
  launch() {
    this.stateDir.ensure();
    this.log(`Launching detached daemon on control port ${this.controlPort}`);
    const daemonProc = spawn2(process.execPath, ["run", DAEMON_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
        AGENTBRIDGE_STATE_DIR: this.stateDir.dir
      },
      detached: true,
      stdio: "ignore"
    });
    daemonProc.unref();
  }
  removeStalePidFile() {
    this.log("Removing stale pid file");
    this.removePidFile();
  }
  acquireLock(depth = 0) {
    if (depth > 1) {
      this.log("Lock acquisition failed after retry, proceeding without lock");
      return true;
    }
    this.stateDir.ensure();
    try {
      const fd = openSync(this.stateDir.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync3(fd, `${process.pid}
`);
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const holderPid = Number.parseInt(readFileSync2(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && !isProcessAlive(holderPid)) {
            this.log(`Stale lock file from dead process ${holderPid}, removing`);
            this.releaseLock();
            return this.acquireLock(depth + 1);
          }
        } catch {
          this.log("Cannot read lock file, removing stale lock");
          this.releaseLock();
          return this.acquireLock(depth + 1);
        }
        return false;
      }
      this.log(`Warning: could not acquire startup lock: ${err.message}`);
      return true;
    }
  }
  releaseLock() {
    try {
      unlinkSync3(this.stateDir.lockFile);
    } catch {}
  }
  async kill(gracefulTimeoutMs = 3000) {
    const pid = this.readPid();
    if (!pid) {
      this.log("No daemon pid file found");
      this.cleanup();
      return false;
    }
    if (!isProcessAlive(pid)) {
      this.log(`Daemon pid ${pid} is not alive, cleaning up stale files`);
      this.cleanup();
      return false;
    }
    if (!this.isDaemonProcess(pid)) {
      this.log(`Pid ${pid} is alive but is NOT an AgentBridge daemon \u2014 refusing to kill. Cleaning up stale pid file.`);
      this.cleanup();
      return false;
    }
    this.log(`Sending SIGTERM to daemon pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.cleanup();
      return false;
    }
    const deadline = Date.now() + gracefulTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        this.log(`Daemon pid ${pid} stopped gracefully`);
        this.cleanup();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.log(`Daemon pid ${pid} did not stop gracefully, sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    this.cleanup();
    return true;
  }
  isDaemonProcess(pid) {
    try {
      const cmd = execFileSync2("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      return cmd.includes("daemon") && (cmd.includes("agentbridge") || cmd.includes("agent_bridge"));
    } catch {
      return false;
    }
  }
  cleanup() {
    this.removePidFile();
    this.removeStatusFile();
    this.releaseLock();
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/config-service.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync4, mkdirSync as mkdirSync3, existsSync as existsSync5 } from "fs";
import { join as join4 } from "path";
var DEFAULT_CONFIG = {
  version: "1.0",
  codex: {
    appPort: 4500,
    proxyPort: 4501
  },
  turnCoordination: {
    attentionWindowSeconds: 15
  },
  idleShutdownSeconds: 30
};
var CONFIG_DIR = ".agentbridge";
var CONFIG_FILE = "config.json";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function normalizeConfig(raw) {
  if (!isRecord(raw))
    return null;
  const config = raw;
  const codex = isRecord(config.codex) ? config.codex : {};
  const daemon = isRecord(config.daemon) ? config.daemon : {};
  const turnCoordination = isRecord(config.turnCoordination) ? config.turnCoordination : {};
  return {
    version: typeof config.version === "string" ? config.version : DEFAULT_CONFIG.version,
    codex: {
      appPort: normalizeInteger(codex.appPort ?? daemon.port, DEFAULT_CONFIG.codex.appPort),
      proxyPort: normalizeInteger(codex.proxyPort ?? daemon.proxyPort, DEFAULT_CONFIG.codex.proxyPort)
    },
    turnCoordination: {
      attentionWindowSeconds: normalizeInteger(turnCoordination.attentionWindowSeconds, DEFAULT_CONFIG.turnCoordination.attentionWindowSeconds)
    },
    idleShutdownSeconds: normalizeInteger(config.idleShutdownSeconds, DEFAULT_CONFIG.idleShutdownSeconds)
  };
}

class ConfigService {
  configDir;
  configPath;
  constructor(projectRoot) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join4(root, CONFIG_DIR);
    this.configPath = join4(this.configDir, CONFIG_FILE);
  }
  hasConfig() {
    return existsSync5(this.configPath);
  }
  load() {
    try {
      const raw = readFileSync3(this.configPath, "utf-8");
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  loadOrDefault() {
    return this.load() ?? structuredClone(DEFAULT_CONFIG);
  }
  save(config) {
    this.ensureConfigDir();
    writeFileSync4(this.configPath, JSON.stringify(config, null, 2) + `
`, "utf-8");
  }
  initDefaults() {
    this.ensureConfigDir();
    const created = [];
    if (!existsSync5(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }
    return created;
  }
  get configFilePath() {
    return this.configPath;
  }
  ensureConfigDir() {
    if (!existsSync5(this.configDir)) {
      mkdirSync3(this.configDir, { recursive: true });
    }
  }
}

// src/control-protocol.ts
var CLOSE_CODE_REPLACED = 4001;
var CLOSE_CODE_EVICTED_STALE = 4002;
var CLOSE_CODE_PROJECT_MISMATCH = 4003;
var CLOSE_CODE_PROBE_IN_PROGRESS = 4004;
var CLOSE_CODE_UNKNOWN_AGENT = 4005;

// src/env-utils.ts
function parsePositiveIntEnv(name, fallback, log = () => {}) {
  const raw = process.env[name];
  if (raw == null || raw === "")
    return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    log(`Invalid ${name}=${JSON.stringify(raw)} (must be a positive integer within ` + `Number.MAX_SAFE_INTEGER); falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

// src/reply-outbox.ts
class ReplyOutbox {
  entries = [];
  max;
  ttlMs;
  constructor(opts) {
    this.max = Math.max(1, opts.max);
    this.ttlMs = opts.ttlMs;
  }
  get size() {
    return this.entries.length;
  }
  get capacity() {
    return this.max;
  }
  peek() {
    return this.entries[0] ?? null;
  }
  accept(reply) {
    this.entries.push(reply);
    const dropped = [];
    while (this.entries.length > this.max) {
      dropped.push(this.entries.shift());
    }
    return { depth: this.entries.length, dropped };
  }
  takeNext(now) {
    const expired = [];
    while (this.entries.length > 0) {
      const next = this.entries.shift();
      if (now - next.queuedAt > this.ttlMs) {
        expired.push(next);
        continue;
      }
      return { reply: next, expired };
    }
    return { reply: null, expired };
  }
  requeue(reply) {
    this.entries.unshift(reply);
    while (this.entries.length > this.max) {
      this.entries.pop();
    }
  }
  clear() {
    return this.entries.splice(0, this.entries.length);
  }
}

// src/daemon-egress.ts
function forEgress(message, protocolVersion) {
  if (protocolVersion !== null && protocolVersion >= 1) {
    const { source: _dropped, ...rest } = message;
    return rest;
  }
  return {
    ...message,
    source: message.from === "claude" ? "claude" : "codex"
  };
}

// src/liveness-probe.ts
var OPEN = 1;
async function probeLiveness(target, options) {
  const {
    timeoutMs,
    pollMs = 50,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = options;
  if (target.readyState !== OPEN)
    return false;
  const baseline = target.pongCount;
  try {
    target.ping();
  } catch {
    return false;
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (target.pongCount > baseline)
      return true;
    if (target.readyState !== OPEN)
      return false;
    await sleep(pollMs);
  }
  return target.pongCount > baseline;
}

// src/frontend-registry.ts
var FRONTEND_AGENTS = ["claude"];
var DEFAULT_FRONTEND_AGENT = "claude";
function parseFrontendAgent(raw) {
  if (raw === undefined || raw === null)
    return DEFAULT_FRONTEND_AGENT;
  return FRONTEND_AGENTS.includes(raw) ? raw : null;
}

class FrontendRegistry {
  opts;
  slots = new Map;
  known = new Set([DEFAULT_FRONTEND_AGENT]);
  probing = new Set;
  constructor(opts) {
    this.opts = opts;
  }
  occupant(agent) {
    return this.slots.get(agent) ?? null;
  }
  isAttached(agent) {
    const socket = this.slots.get(agent);
    return socket !== undefined && this.opts.isOpen(socket);
  }
  attachedAgents() {
    return [...this.slots.keys()];
  }
  get size() {
    return this.slots.size;
  }
  knownAgents() {
    return [...this.known];
  }
  isProbing(agent) {
    return this.probing.has(agent);
  }
  beginProbe(agent) {
    this.probing.add(agent);
  }
  endProbe(agent) {
    this.probing.delete(agent);
  }
  contestedBy(agent, socket) {
    const occupant = this.slots.get(agent);
    if (!occupant || occupant === socket)
      return null;
    return this.opts.isClosed(occupant) ? null : occupant;
  }
  claim(agent, socket) {
    this.slots.set(agent, socket);
    this.known.add(agent);
  }
  release(agent, socket) {
    if (this.slots.get(agent) !== socket)
      return false;
    this.slots.delete(agent);
    return true;
  }
  releaseSocket(socket) {
    for (const [agent, held] of this.slots) {
      if (held === socket) {
        this.slots.delete(agent);
        return agent;
      }
    }
    return null;
  }
  writable() {
    const out = [];
    for (const [agent, socket] of this.slots) {
      if (!this.opts.isOpen(socket))
        continue;
      out.push({ agent, socket });
    }
    return out;
  }
}

// src/mailbox.ts
var EMPTY_COUNTS = {
  reply: 0,
  status: 0,
  fyi: 0,
  untagged: 0
};

class Mailbox {
  agent;
  opts;
  entries = [];
  dropped = { ...EMPTY_COUNTS };
  unreportedDrops = 0;
  nextId;
  batchSeq = 0;
  constructor(agent, opts) {
    this.agent = agent;
    this.opts = opts;
    this.nextId = opts.nextId ?? (() => `gap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }
  get size() {
    return this.entries.length;
  }
  droppedCounts() {
    return { ...this.dropped };
  }
  enqueue(message) {
    if (this.entries.length < this.opts.capacity) {
      this.push(message);
      return { accepted: true };
    }
    switch (message.kind) {
      case "reply": {
        const allLeased = this.entries.every((e) => e.leasedBy !== null);
        return {
          accepted: false,
          reason: allLeased ? `${this.agent}'s mailbox is full (${this.opts.capacity} messages, all awaiting ack). The reply was not delivered.` : `${this.agent}'s mailbox is full (${this.opts.capacity} messages). The reply was not delivered.`
        };
      }
      case "status": {
        if (this.opts.capacity < 2) {
          if (this.dropOldestFree()) {
            this.push(message);
          } else {
            this.dropped[message.kind]++;
            this.unreportedDrops++;
          }
          return { accepted: true };
        }
        const collapsed = this.collapseOldest("status");
        if (this.entries.length > this.opts.capacity - 2) {
          if (collapsed > 0)
            this.pushFront(this.statusGapEntry(collapsed, message.timestamp));
          this.dropped[message.kind]++;
          this.unreportedDrops++;
          return { accepted: true };
        }
        this.pushFront(this.statusGapEntry(collapsed, message.timestamp));
        this.push(message);
        return { accepted: true };
      }
      case "fyi":
        this.dropped.fyi++;
        this.unreportedDrops++;
        return { accepted: true };
      case "untagged":
        if (this.dropOldestFree()) {
          this.push(message);
        } else {
          this.dropped.untagged++;
          this.unreportedDrops++;
        }
        return { accepted: true };
    }
  }
  remove(ids) {
    const doomed = new Set(ids);
    for (let i = this.entries.length - 1;i >= 0; i--) {
      if (doomed.has(this.entries[i].message.id))
        this.entries.splice(i, 1);
    }
  }
  drain(now) {
    const batchId = `${this.agent}_b${++this.batchSeq}_${now}`;
    const gap = this.takeGapMarker(now);
    if (gap)
      this.pushFront(gap);
    const messages = [];
    for (const entry of this.entries) {
      if (entry.leasedBy !== null && entry.leaseExpiresAt > now)
        continue;
      entry.leasedBy = batchId;
      entry.leaseExpiresAt = now + this.opts.leaseTimeoutMs;
      messages.push(entry.message);
    }
    return { batchId, messages };
  }
  ack(batchId, ids) {
    const named = new Set(ids);
    let deleted = 0;
    for (let i = this.entries.length - 1;i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.leasedBy !== batchId)
        continue;
      if (!named.has(entry.message.id))
        continue;
      this.entries.splice(i, 1);
      deleted++;
    }
    return deleted;
  }
  push(message) {
    this.entries.push({ message, leasedBy: null, leaseExpiresAt: 0 });
  }
  pushFront(message) {
    this.entries.unshift({ message, leasedBy: null, leaseExpiresAt: 0 });
  }
  collapseOldest(kind) {
    let removed = 0;
    while (this.entries.length > this.opts.capacity - 2) {
      const idx = this.entries.findIndex((e) => e.leasedBy === null && e.message.kind === kind);
      if (idx !== -1) {
        this.entries.splice(idx, 1);
        removed++;
        this.dropped[kind]++;
        continue;
      }
      if (!this.dropOldestFree())
        break;
      removed++;
    }
    return removed;
  }
  dropOldestFree() {
    const idx = this.entries.findIndex((e) => e.leasedBy === null);
    if (idx === -1)
      return false;
    const victim = this.entries.splice(idx, 1)[0];
    this.dropped[victim.message.kind]++;
    this.unreportedDrops++;
    return true;
  }
  statusGapEntry(collapsed, timestamp) {
    return {
      id: this.nextId(),
      from: "system",
      to: this.agent,
      kind: "status",
      content: `[gap] ${collapsed} status message(s) elided \u2014 mailbox at capacity`,
      timestamp
    };
  }
  takeGapMarker(now) {
    if (this.unreportedDrops === 0)
      return null;
    const content = `[gap] ${this.unreportedDrops} message(s) dropped \u2014 mailbox at capacity`;
    this.unreportedDrops = 0;
    return {
      id: this.nextId(),
      from: "system",
      to: this.agent,
      kind: "untagged",
      content,
      timestamp: now
    };
  }
}

// src/message-index.ts
class MessageIndex {
  opts;
  entries = new Map;
  constructor(opts) {
    this.opts = opts;
  }
  get size() {
    return this.entries.size;
  }
  record(id, entry, now) {
    if (this.entries.has(id))
      return false;
    if (this.entries.size >= this.opts.capacity) {
      this.evictExpired(now);
      if (this.entries.size >= this.opts.capacity) {
        return false;
      }
    }
    this.entries.set(id, entry);
    return true;
  }
  delete(id) {
    this.entries.delete(id);
  }
  resolveSender(id, replier, now) {
    const entry = this.entries.get(id);
    if (!entry)
      return null;
    if (now - entry.at > this.opts.ttlMs)
      return null;
    if (!isAgentId(entry.from))
      return null;
    if (!entry.recipients.includes(replier))
      return null;
    return entry.from;
  }
  evictExpired(now) {
    for (const [id, entry] of this.entries) {
      if (now - entry.at > this.opts.ttlMs)
        this.entries.delete(id);
    }
  }
}

// src/routing.ts
class RoutingError extends Error {
}
function resolveRecipients(envelope, state, now) {
  const everyoneElse = () => state.knownAgents().filter((a) => a !== envelope.from);
  if (isAgentId(envelope.to)) {
    if (envelope.to === envelope.from) {
      throw new RoutingError(`${envelope.from} addressed itself; a sender is never its own recipient`);
    }
    if (!state.knownAgents().includes(envelope.to)) {
      throw new RoutingError(`${envelope.to} has never connected to this bridge, so it has no session to deliver to. The message was not sent.`);
    }
    return [envelope.to];
  }
  if (envelope.to === "*")
    return everyoneElse();
  if (envelope.from === "system")
    return everyoneElse();
  if (envelope.inReplyTo !== undefined) {
    const target = state.senderOf(envelope.inReplyTo, envelope.from, now);
    if (target === null) {
      throw new RoutingError(`Cannot reply to "${envelope.inReplyTo}" \u2014 unknown, expired, or not addressed to ${envelope.from}.`);
    }
    return [target];
  }
  const requester = state.activeRequesterFor(envelope.from);
  if (requester !== null)
    return [requester];
  return everyoneElse();
}

// src/message-bus.ts
class SendRejected extends Error {
}

class MessageBus {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async route(envelope, now) {
    const recipients = resolveRecipients(envelope, this.deps.state, now);
    const accepted = [];
    const rejected = [];
    for (const agent of recipients) {
      const result = this.deps.mailboxFor(agent).enqueue(envelope);
      if (result.accepted)
        accepted.push(agent);
      else
        rejected.push({ agent, reason: result.reason ?? "rejected" });
    }
    if (accepted.length === 0) {
      throw new SendRejected(rejected.length > 0 ? rejected.map((r) => r.reason).join(" ") : `No recipient resolved for message ${envelope.id}.`);
    }
    const recorded = this.deps.index.record(envelope.id, { from: envelope.from, recipients: accepted, at: now }, now);
    if (!recorded) {
      this.rollback(accepted, envelope.id);
      throw new SendRejected("The provenance index is full of live entries; the message was not delivered. Retry once older conversations expire.");
    }
    for (const agent of accepted) {
      await this.deps.transports.wake(agent, envelope, this.deps.log);
    }
    return { id: envelope.id, accepted, rejected };
  }
  rollback(agents, id) {
    for (const agent of agents)
      this.deps.mailboxFor(agent).remove([id]);
    this.deps.log(`Rolled back ${id} from ${agents.join(", ")} \u2014 index insertion failed`);
  }
}

// src/pending-requests.ts
class PendingRequests {
  requests = [];
  get size() {
    return this.requests.length;
  }
  add(req) {
    this.requests.push(req);
  }
  satisfy(inReplyTo, recipients, responder) {
    const satisfied = [];
    for (let i = this.requests.length - 1;i >= 0; i--) {
      const req = this.requests[i];
      if (req.responder !== responder)
        continue;
      const named = inReplyTo !== undefined && inReplyTo === req.messageId;
      const routed = recipients.includes(req.requester);
      if (!named && !routed)
        continue;
      this.requests.splice(i, 1);
      satisfied.push(req);
    }
    return satisfied.reverse();
  }
  cancel(messageId) {
    const i = this.requests.findIndex((r) => r.messageId === messageId);
    if (i === -1)
      return null;
    return this.requests.splice(i, 1)[0];
  }
  expire(now, ttlMs) {
    const expired = [];
    for (let i = this.requests.length - 1;i >= 0; i--) {
      if (now - this.requests[i].at <= ttlMs)
        continue;
      expired.push(...this.requests.splice(i, 1));
    }
    return expired.reverse();
  }
}

// src/wakeup-transport.ts
class TransportRegistry {
  transports = new Map;
  register(agent, transport) {
    this.transports.set(agent, transport);
  }
  unregister(agent) {
    this.transports.delete(agent);
  }
  get(agent) {
    return this.transports.get(agent) ?? null;
  }
  async wake(agent, message, log) {
    const transport = this.transports.get(agent);
    if (!transport) {
      log(`No wake-up transport for ${agent}; ${message.id} waits in the mailbox`);
      return "no-transport";
    }
    try {
      await transport.wake(message);
      return "woken";
    } catch (err) {
      log(`Wake-up for ${agent} failed (${describeError(err)}); ${message.id} stays in the mailbox`);
      return "failed";
    }
  }
}
function describeError(err) {
  if (err instanceof Error)
    return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// src/daemon-bus.ts
function deliveryHintFor(message, mode) {
  if (mode === "full")
    return "push";
  switch (message.kind) {
    case "reply":
      return "push";
    case "status":
    case "fyi":
      return "queue";
    case "untagged":
      return message.from === "system" ? "push" : "queue";
  }
}
function senderFacingText(outcome) {
  switch (outcome.status) {
    case "delivered":
      return null;
    case "partial":
      return outcome.note;
    case "failed":
      return outcome.error;
  }
}
async function routeThroughBus(deps, envelope) {
  const { bus, log } = deps;
  try {
    const outcome = await bus.route(envelope, (deps.now ?? Date.now)());
    if (outcome.rejected.length === 0)
      return { status: "delivered", accepted: outcome.accepted };
    log(`Message ${envelope.id} rejected by ${outcome.rejected.map((r) => r.agent).join(", ")}`);
    return {
      status: "partial",
      note: outcome.rejected.map((r) => r.reason).join(" "),
      accepted: outcome.accepted
    };
  } catch (err) {
    if (err instanceof RoutingError || err instanceof SendRejected) {
      log(`Message ${envelope.id} was not delivered: ${err.message}`);
      return { status: "failed", error: err.message };
    }
    log(`Message ${envelope.id} failed to route: ${describeRouteError(err)}`);
    return { status: "failed", error: "The daemon could not route this message." };
  }
}
function describeRouteError(err) {
  if (err instanceof Error)
    return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
function registerTransport(deps, agent, transport) {
  if (transport.acknowledgementMode !== "none") {
    deps.transports.register(agent, transport);
    return;
  }
  deps.transports.register(agent, {
    ...transport,
    wake: async (message) => {
      await transport.wake(message);
      deps.mailboxFor(agent).remove([message.id]);
    }
  });
}

// src/normalize-ingress.ts
var PROTOCOL_VERSION = 1;

class IngressError extends Error {
}
var KINDS = ["reply", "status", "fyi", "untagged"];
function normalizeIngress(raw, socket, ctx) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IngressError("Ingress payload must be an object.");
  }
  const p = raw;
  if (socket.protocolVersion !== null && socket.protocolVersion >= PROTOCOL_VERSION) {
    const declared = p.from ?? p.source;
    if (declared !== undefined && declared !== socket.agent) {
      throw new IngressError(`Payload claims from="${String(declared)}" but the socket is authenticated as "${socket.agent}".`);
    }
  }
  const to = readTo(p.to);
  const kindPresent = p.kind !== undefined && p.kind !== null;
  const kind = readKind(p.kind);
  if (p.content !== undefined && typeof p.content !== "string") {
    throw new IngressError("`content` must be a string.");
  }
  if (p.inReplyTo !== undefined && typeof p.inReplyTo !== "string") {
    throw new IngressError("`inReplyTo` must be a string.");
  }
  if (p.senderRef !== undefined && typeof p.senderRef !== "string") {
    throw new IngressError("`senderRef` must be a string.");
  }
  const content = typeof p.content === "string" ? p.content : "";
  let body = content;
  let finalTo = to;
  let finalKind = kind;
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError)
      throw new IngressError(err.message);
    throw err;
  }
  if (marker.marker !== "untagged" || marker.to !== null) {
    if (marker.to !== null && to !== null && marker.to !== to) {
      throw new IngressError(`Conflict: structured to="${to}" but the content is marked "@${marker.to}". Two sources of truth for one destination.`);
    }
    if (kindPresent && marker.marker !== "untagged" && marker.marker !== kind) {
      throw new IngressError(`Conflict: structured kind="${kind}" but the content is marked "[${marker.marker.toUpperCase()}]".`);
    }
    finalTo = to ?? marker.to;
    if (!kindPresent && marker.marker !== "untagged")
      finalKind = marker.marker;
    body = marker.body;
  }
  return {
    id: ctx.id,
    senderRef: typeof p.senderRef === "string" ? p.senderRef : undefined,
    from: socket.agent,
    to: finalTo,
    inReplyTo: typeof p.inReplyTo === "string" ? p.inReplyTo : undefined,
    kind: finalKind,
    content: body,
    timestamp: ctx.now
  };
}
function normalizeProse(content, socket, ctx) {
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError)
      throw new IngressError(err.message);
    throw err;
  }
  return {
    id: ctx.id,
    senderRef: ctx.senderRef,
    from: socket.agent,
    to: marker.to,
    kind: marker.marker,
    content: marker.body,
    timestamp: ctx.now
  };
}
function readTo(v) {
  if (v === undefined || v === null)
    return null;
  if (v === "*")
    return "*";
  if (typeof v !== "string")
    throw new IngressError("`to` must be a string.");
  const parsed = parseAgentId(v);
  if (parsed === null) {
    throw new IngressError(`Unknown recipient "${v}". Known agents: claude, grok, codex.`);
  }
  return parsed;
}
function readKind(v) {
  if (v === undefined || v === null)
    return "untagged";
  if (typeof v === "string" && KINDS.includes(v))
    return v;
  throw new IngressError(`Unknown kind "${String(v)}". Expected one of ${KINDS.join(", ")}.`);
}

// src/daemon-constants.ts
var MAILBOX_CAPACITY = 100;
var LEASE_TIMEOUT_MS = 30000;
var INDEX_TTL_MS = 3600000;
var INDEX_CAPACITY = 5000;

// src/daemon.ts
var FRONTEND_AGENT_LIST = FRONTEND_AGENTS.join(", ");
var DAEMON_PROJECT_ID = process.env.AGENTBRIDGE_PROJECT_ID ?? null;
var stateDir = new StateDirResolver;
stateDir.ensure();
var configService = new ConfigService;
var config = configService.loadOrDefault();
var daemonStatusLine = new StatusLineWriter(stateDir);
var CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
var CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
var CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
var TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
var CLAUDE_DISCONNECT_GRACE_MS = 5000;
var FILTER_MODE = process.env.AGENTBRIDGE_FILTER_MODE === "full" ? "full" : "filtered";
var IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
var ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);
var daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
var codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
var attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;
var grok = new GrokAdapter({
  socketPath: stateDir.grokLeaderSocket,
  logFile: stateDir.logFile
});
var grokEverAttached = false;
var controlServer = null;
var frontends = new FrontendRegistry({
  isOpen: (ws) => ws.readyState === WebSocket.OPEN,
  isClosed: (ws) => ws.readyState === WebSocket.CLOSED
});
function claudeSocket() {
  return frontends.occupant(DEFAULT_FRONTEND_AGENT);
}
var nextControlClientId = 0;
var nextSystemMessageId = 0;
var codexBootstrapped = false;
var attentionWindowTimer = null;
var inAttentionWindow = false;
var shuttingDown = false;
var idleShutdownTimer = null;
var pendingRequestsTimer = null;
var claudeDisconnectTimer = null;
var claudeOnlineNoticeSent = false;
var claudeOfflineNoticeShown = false;
var codexCollaborationKickoffSent = false;
var lastAttachStatusSentTs = 0;
var ATTACH_STATUS_COOLDOWN_MS = 30000;
var PIN_CONTRACT_MODE = (process.env.AGENTBRIDGE_PIN_CONTRACT ?? "off").toLowerCase();
var lastPinnedContractThreadId = null;
var LIVENESS_PROBE_TIMEOUT_MS = parsePositiveIntEnv("AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS", 3000, log);
var LIVENESS_PROBE_POLL_MS = 50;
var replyOutbox = new ReplyOutbox({
  max: parsePositiveIntEnv("AGENTBRIDGE_REPLY_QUEUE_MAX", 3, log),
  ttlMs: parsePositiveIntEnv("AGENTBRIDGE_REPLY_QUEUE_TTL_MS", 10 * 60000, log)
});
var pendingRequests = new PendingRequests;
var PENDING_REQUEST_TTL_MS = parsePositiveIntEnv("AGENTBRIDGE_REPLY_REQUIRED_TTL_MS", 10 * 60000, log);
var PENDING_REQUEST_CHECK_INTERVAL_MS = 30000;
var mailboxes = new Map;
function mailboxFor(agent) {
  let box = mailboxes.get(agent);
  if (!box) {
    box = new Mailbox(agent, { capacity: MAILBOX_CAPACITY, leaseTimeoutMs: LEASE_TIMEOUT_MS });
    mailboxes.set(agent, box);
  }
  return box;
}
var messageIndex = new MessageIndex({ capacity: INDEX_CAPACITY, ttlMs: INDEX_TTL_MS });
var transports = new TransportRegistry;
var activeRequester = new Map;
var bus = new MessageBus({
  mailboxFor,
  index: messageIndex,
  state: {
    knownAgents: () => ["codex", ...grokEverAttached ? ["grok"] : [], ...frontends.knownAgents()],
    senderOf: (id, replier, now) => messageIndex.resolveSender(id, replier, now),
    activeRequesterFor: (agent) => activeRequester.get(agent) ?? null
  },
  transports,
  log
});
var idSeq = 0;
function nextMessageId() {
  return `msg_${Date.now()}_${++idSeq}`;
}
var requireReplyIds = new Set;
var codexDeferralNotes = new Map;
var outboxRequester = new Map;
function registerTransport2(agent, transport) {
  registerTransport({ transports, mailboxFor }, agent, transport);
}
registerTransport2("codex", {
  payloadMode: "content",
  acknowledgementMode: "none",
  wake: (message) => {
    const requireReply = requireReplyIds.delete(message.id);
    const requester = isAgentId(message.from) ? message.from : null;
    if (deliverToCodex(message.content, requireReply, requester, message.id)) {
      clearAttentionWindow();
      return;
    }
    const { depth, dropped } = replyOutbox.accept({
      id: message.id,
      content: message.content,
      requireReply,
      queuedAt: Date.now()
    });
    if (requester)
      outboxRequester.set(message.id, requester);
    log(`Queued reply for Codex while it was busy (depth ${depth}, dropped ${dropped.length})`);
    let note = codex.turnPending ? depth > 1 ? `Codex is mid-turn. Held for delivery when the turn ends (${depth} replies now queued, sent in order).` : "Codex is mid-turn. Held for delivery when the turn ends." : "Codex has no thread to inject into right now. Held for delivery when one is available.";
    if (dropped.length > 0) {
      note += ` ${dropped.length} older queued repl${dropped.length > 1 ? "ies were" : "y was"}` + ` dropped to stay under the ${replyOutbox.capacity}-message limit.`;
    }
    codexDeferralNotes.set(message.id, note);
  }
});
registerTransport2("grok", {
  payloadMode: "content",
  acknowledgementMode: "none",
  wake: (message) => {
    const requireReply = requireReplyIds.delete(message.id);
    const requester = isAgentId(message.from) ? message.from : "system";
    const content = requireReply ? message.content + REPLY_REQUIRED_INSTRUCTION : message.content;
    const accepted = grok.injectMessage(content, {
      messageId: message.id,
      requester,
      text: message.content
    });
    if (!accepted)
      throw new Error("Grok has no live session to inject into");
    if (requireReply && isAgentId(message.from)) {
      pendingRequests.add({
        requester: message.from,
        responder: "grok",
        messageId: message.id,
        at: Date.now()
      });
      log(`Reply required from Grok for ${message.id} (requester: ${message.from})`);
    }
  }
});
function drainGrokBacklog(why) {
  const batch = mailboxFor("grok").drain(Date.now());
  if (batch.messages.length === 0)
    return;
  log(`Delivering ${batch.messages.length} held message(s) to Grok (${why})`);
  for (const message of batch.messages) {
    transports.wake("grok", message, log);
  }
}
function frontendTransport(agent) {
  return {
    payloadMode: "content",
    acknowledgementMode: "explicit",
    wake: (message) => {
      const socket = frontends.occupant(agent);
      if (socket === null || !frontends.isAttached(agent)) {
        throw new Error(`${agent} is not attached`);
      }
      if (!trySendBridgeMessage(socket, message, deliveryHintFor(message, FILTER_MODE))) {
        throw new Error(`the control socket for ${agent} refused the frame`);
      }
    }
  };
}
for (const agent of FRONTEND_AGENTS)
  registerTransport2(agent, frontendTransport(agent));
async function routeThroughBus2(envelope) {
  return routeThroughBus({ bus, log }, envelope);
}
function routeOrLog(envelope) {
  routeThroughBus2(envelope).then((outcome) => {
    const text = senderFacingText(outcome);
    if (text !== null)
      log(`Daemon-authored ${envelope.id}: ${text}`);
  });
}
function emitToFrontends(build) {
  for (const agent of frontends.knownAgents())
    routeOrLog(build(agent));
}
function notifyFrontends(build) {
  for (const agent of frontends.attachedAgents()) {
    transports.wake(agent, build(agent), log);
  }
}
function describeError2(err) {
  if (err instanceof Error)
    return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
var tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    notifyFrontends((to) => systemMessage("system_tui_disconnected", `\u26A0\uFE0F Codex TUI disconnected (conn #${connId}). Codex is still running in the background \u2014 reconnect the TUI to resume.`, to));
  },
  onReconnectAfterNotice: (connId) => {
    notifyFrontends((to) => systemMessage("system_tui_reconnected", `\u2705 Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`, to));
    codex.injectMessage("\u2705 Claude Code is still online, bridge restored. Bidirectional communication can continue.");
  }
});
var statusBuffer = new StatusBuffer((summary) => emitToFrontends((to) => ({
  ...summary,
  id: `status_summary_${++nextSystemMessageId}`,
  to
})));
codex.on("turnStarted", () => {
  log("Codex turn started");
  notifyFrontends((to) => systemMessage("system_turn_started", "\u23F3 Codex is working on the current task. Wait for completion before sending a reply.", to));
});
var pendingCodexNotices = [];
var droppedCodexNotices = 0;
var PENDING_CODEX_NOTICE_CAP = 20;
function tellCodex(text) {
  const framed = `[AgentBridge] ${text}`;
  if (codex.injectMessage(framed))
    return;
  pendingCodexNotices.push(framed);
  while (pendingCodexNotices.length > PENDING_CODEX_NOTICE_CAP) {
    pendingCodexNotices.shift();
    droppedCodexNotices++;
  }
  log(`Deferred an AgentBridge notice to Codex (${pendingCodexNotices.length} pending)`);
}
function flushPendingCodexNotices() {
  if (pendingCodexNotices.length === 0)
    return;
  const parts = [...pendingCodexNotices];
  if (droppedCodexNotices > 0) {
    parts.unshift(`[AgentBridge] ${droppedCodexNotices} earlier notice${droppedCodexNotices > 1 ? "s were" : " was"}` + ` dropped to stay under the ${PENDING_CODEX_NOTICE_CAP}-notice limit.`);
  }
  if (!codex.injectMessage(parts.join(`

`))) {
    log(`Could not flush ${pendingCodexNotices.length} held AgentBridge notice(s); keeping them`);
    return;
  }
  log(`Flushed ${pendingCodexNotices.length} held AgentBridge notice(s) to Codex`);
  pendingCodexNotices.length = 0;
  droppedCodexNotices = 0;
}
async function handleProxiedMessage(msg) {
  const { agent, tell } = msg;
  const label = agentLabel(agent);
  if (msg.respondingTo && isAgentId(msg.respondingTo.requester)) {
    activeRequester.set(agent, msg.respondingTo.requester);
  }
  let result;
  try {
    result = classifyMessage(msg.content, FILTER_MODE);
  } catch (err) {
    tell(describeError2(err));
    return;
  }
  let envelope;
  try {
    envelope = normalizeProse(msg.content, { agent, protocolVersion: PROTOCOL_VERSION }, { id: nextMessageId(), now: Date.now(), senderRef: msg.senderRef });
  } catch (err) {
    tell(describeError2(err));
    return;
  }
  if (FILTER_MODE !== "full" && inAttentionWindow && result.marker === "status") {
    log(`${label} \u2192 bus [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(envelope);
    return;
  }
  log(`${label} \u2192 bus [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  if (result.action === "buffer") {
    statusBuffer.add(envelope);
    return;
  }
  if (result.marker === "reply" && statusBuffer.size > 0) {
    statusBuffer.flush("reply message arrived");
  }
  const outcome = await routeThroughBus2(envelope);
  const text = senderFacingText(outcome);
  if (text !== null)
    tell(text);
  if (outcome.status === "failed")
    return;
  if (result.marker === "reply") {
    pendingRequests.satisfy(envelope.inReplyTo ?? msg.respondingTo?.messageId, outcome.accepted, agent);
    startAttentionWindow();
  }
}
function receiveProxiedMessage(msg) {
  handleProxiedMessage(msg).catch((err) => {
    log(`${msg.agent} agentMessage handler failed for ${msg.senderRef}: ${describeError2(err)}`);
  });
}
codex.on("agentMessage", (msg) => {
  receiveProxiedMessage({
    agent: "codex",
    senderRef: msg.senderRef,
    content: msg.content,
    respondingTo: null,
    tell: tellCodex
  });
});
function endAgentTurn(agent, why) {
  if (!activeRequester.has(agent))
    return;
  log(`Clearing ${agentLabel(agent)}'s turn-scoped requester: ${why}`);
  activeRequester.delete(agent);
}
codex.on("turnCompleted", () => {
  log("Codex turn completed");
  statusBuffer.flush("turn completed");
  endAgentTurn("codex", "the turn completed");
  notifyFrontends((to) => systemMessage("system_turn_completed", "\u2705 Codex finished the current turn. You can reply now if needed.", to));
  startAttentionWindow();
  if (claudeSocket() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
  flushPendingCodexNotices();
  drainReplyOutbox();
});
codex.on("ready", (threadId) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready \u2014 thread ${threadId}`);
  log("Bridge fully operational");
  notifyFrontends((to) => systemMessage("system_ready", currentReadyMessage(), to));
  if (claudeSocket() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});
codex.on("tuiConnected", (connId) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});
codex.on("tuiDisconnected", (connId) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});
codex.on("error", (err) => {
  log(`Codex error: ${err.message}`);
});
codex.on("turnAborted", (why) => {
  endAgentTurn("codex", why);
});
function reportInjectionRejected(rejection) {
  const { agent, messageId, unit, reason } = rejection;
  const label = agentLabel(agent);
  log(`${label} refused the ${unit} for ${messageId}: ${reason}`);
  endAgentTurn(agent, `${label} refused the ${unit}`);
  if (pendingRequests.cancel(messageId)) {
    log(`Cancelled the pending reply request for refused message ${messageId}`);
  }
  const notice = (to) => noticeMessage(rejection.kind, `\u26A0\uFE0F ${label} refused the ${unit} carrying your message \u2014 it was not delivered and ${label} never saw it. ` + `The ${rejection.backend} said: ${reason}

Undelivered message:
${truncateForNotice(rejection.text)}`, to);
  const sender = isAgentId(rejection.requester) ? rejection.requester : null;
  if (sender)
    routeOrLog(notice(sender));
  else
    emitToFrontends(notice);
}
codex.on("injectionRejected", ({ correlation, error }) => {
  lastPinnedContractThreadId = null;
  reportInjectionRejected({
    agent: "codex",
    kind: "turn_start_rejected",
    unit: "turn",
    backend: "app-server",
    messageId: correlation.id,
    requester: correlation.requester,
    text: correlation.text,
    reason: error
  });
});
codex.on("exit", (code) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  endAgentTurn("codex", "the Codex app-server exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  lastPinnedContractThreadId = null;
  discardOutboxForLostCodex("the Codex app-server exited");
  notifyFrontends((to) => systemMessage("system_codex_exit", `\u26A0\uFE0F Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`, to));
  broadcastStatus();
});
function tellGrok(text) {
  if (!grok.injectMessage(`[AgentBridge] ${text}`)) {
    log(`Could not tell Grok: ${text}`);
  }
}
grok.on("agentMessage", (msg) => {
  receiveProxiedMessage({
    agent: "grok",
    senderRef: msg.senderRef,
    content: msg.content,
    respondingTo: msg.respondingTo,
    tell: tellGrok
  });
});
grok.on("sessionAttached", (sessionId) => {
  log(`Grok session attached: ${sessionId}`);
  grokEverAttached = true;
  drainGrokBacklog("a Grok session became available");
  broadcastStatus();
});
grok.on("turnCompleted", () => {
  log("Grok turn completed");
  endAgentTurn("grok", "the turn completed");
});
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
grok.on("injectionRejected", ({ messageId, requester, text, reason }) => {
  reportInjectionRejected({
    agent: "grok",
    kind: "grok_prompt_rejected",
    unit: "prompt",
    backend: "leader",
    messageId,
    requester,
    text,
    reason
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
      if (url.pathname === "/ws" && server.upgrade(req, {
        data: {
          clientId: 0,
          agent: DEFAULT_FRONTEND_AGENT,
          attached: false,
          lastPongAt: Date.now(),
          pongCount: 0,
          protocolVersion: null
        }
      })) {
        return;
      }
      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount = 0;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws, code, reason) => {
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, wasAttached=${ws.data.attached})`);
        detachFrontend(ws, "frontend socket closed");
      },
      message: (ws, raw) => {
        handleControlMessage(ws, raw);
      },
      pong: (ws) => {
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount++;
      }
    }
  });
}
function acceptsFrontend(theirs) {
  if (theirs === undefined) {
    if (DAEMON_PROJECT_ID !== null) {
      log(`Frontend did not declare a project id; serving it as ${DAEMON_PROJECT_ID} (older bundle?).`);
    }
    return true;
  }
  return theirs === DAEMON_PROJECT_ID;
}
function handleControlMessage(ws, raw) {
  if (ws.data.rejected)
    return;
  let message;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }
  switch (message.type) {
    case "claude_connect":
      if (!acceptsFrontend(message.projectId)) {
        log(`Refusing claude_connect from project ${message.projectId} \u2014 ` + `this daemon serves ${DAEMON_PROJECT_ID}.`);
        ws.data.rejected = true;
        ws.close(CLOSE_CODE_PROJECT_MISMATCH, `This daemon serves project ${DAEMON_PROJECT_ID}, not ${message.projectId}. ` + `Two projects derive the same control port \u2014 run \`abg doctor\`.`);
        return;
      }
      {
        const agent = parseFrontendAgent(message.agent);
        if (agent === null) {
          log(`Refusing claude_connect from #${ws.data.clientId} \u2014 unknown agent ${JSON.stringify(message.agent)}`);
          ws.data.rejected = true;
          ws.close(CLOSE_CODE_UNKNOWN_AGENT, `Unknown frontend agent ${JSON.stringify(message.agent)} \u2014 this daemon serves ${FRONTEND_AGENT_LIST}.`);
          return;
        }
        ws.data.agent = agent;
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
      if (!ws.data.attached) {
        sendProtocolMessage(ws, {
          type: "drain_result",
          requestId: message.requestId,
          batchId: "",
          messages: []
        });
        return;
      }
      const batch = mailboxFor(ws.data.agent).drain(Date.now());
      sendProtocolMessage(ws, {
        type: "drain_result",
        requestId: message.requestId,
        batchId: batch.batchId,
        messages: batch.messages.map((m) => forEgress(m, ws.data.protocolVersion))
      });
      return;
    }
    case "ack": {
      if (!ws.data.attached)
        return;
      const deleted = mailboxFor(ws.data.agent).ack(message.batchId, message.ids);
      log(`Ack from ${ws.data.agent}: ${deleted}/${message.ids.length} entries deleted`);
      return;
    }
    case "claude_to_codex": {
      if (!ws.data.attached) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "This socket is not attached. Send claude_connect first."
        });
        return;
      }
      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Codex is not ready. Wait for TUI to connect and create a thread."
        });
        return;
      }
      sendFromFrontend(ws, message.requestId, message.message, !!message.requireReply);
      return;
    }
  }
}
async function sendFromFrontend(ws, requestId, frame, requireReply) {
  let envelope;
  try {
    envelope = normalizeIngress(frame, { agent: ws.data.agent, protocolVersion: ws.data.protocolVersion }, { id: nextMessageId(), now: Date.now() });
  } catch (err) {
    sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId,
      success: false,
      error: describeError2(err)
    });
    return;
  }
  if (requireReply)
    requireReplyIds.add(envelope.id);
  const outcome = await routeThroughBus2(envelope);
  requireReplyIds.delete(envelope.id);
  if (outcome.status === "failed") {
    sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId,
      success: false,
      error: outcome.error
    });
    return;
  }
  const deferral = codexDeferralNotes.get(envelope.id);
  codexDeferralNotes.delete(envelope.id);
  const shed = senderFacingText(outcome);
  const note = [deferral, shed].filter((t) => t !== null && t !== undefined).join(" ");
  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId,
    success: true,
    queued: deferral !== undefined ? true : undefined,
    note: note === "" ? undefined : note
  });
}
function deliverToCodex(content, requireReply, requester, messageId) {
  const activeThreadId = codex.activeThreadId;
  const needsContract = PIN_CONTRACT_MODE === "always" || PIN_CONTRACT_MODE === "once" && activeThreadId !== lastPinnedContractThreadId;
  let contentToSend = content;
  if (needsContract)
    contentToSend += `

` + BRIDGE_CONTRACT_REMINDER;
  if (requireReply)
    contentToSend += REPLY_REQUIRED_INSTRUCTION;
  log(`Forwarding Claude \u2192 Codex (${content.length} chars, requireReply=${requireReply}, pinnedContract=${needsContract})`);
  if (!codex.injectMessage(contentToSend, { id: messageId, requester, text: content }))
    return false;
  if (needsContract && PIN_CONTRACT_MODE === "once" && activeThreadId) {
    lastPinnedContractThreadId = activeThreadId;
    log(`Pinned BRIDGE_CONTRACT_REMINDER for thread ${activeThreadId.slice(0, 8)}; subsequent msgs skip the reminder`);
  }
  if (requireReply && requester) {
    pendingRequests.add({ requester, responder: "codex", messageId, at: Date.now() });
    log(`Reply required from Codex for ${messageId} (requester: ${requester})`);
  }
  if (requester)
    activeRequester.set("codex", requester);
  return true;
}
function drainReplyOutbox() {
  const { reply, expired } = replyOutbox.takeNext(Date.now());
  for (const stale of expired) {
    const waitedMin = Math.round((Date.now() - stale.queuedAt) / 60000);
    log(`Dropping expired queued reply ${stale.id} (waited ~${waitedMin}m)`);
    outboxRequester.delete(stale.id);
    emitToFrontends((to) => noticeMessage("reply_expired", `\u26A0\uFE0F A reply you sent while Codex was busy waited ~${waitedMin} minutes and was dropped without being delivered. ` + `Codex never saw it. Send it again if it still applies.

Dropped message:
${truncateForNotice(stale.content)}`, to));
  }
  if (!reply)
    return;
  if (deliverToCodex(reply.content, reply.requireReply, outboxRequester.get(reply.id) ?? null, reply.id)) {
    outboxRequester.delete(reply.id);
    clearAttentionWindow();
    log(`Delivered queued reply ${reply.id} after turn completion`);
    emitToFrontends((to) => noticeMessage("reply_delivered", "\uD83D\uDCE4 The reply you sent while Codex was busy has now been delivered \u2014 Codex is starting a turn on it.", to));
    return;
  }
  if (codex.turnPending) {
    replyOutbox.requeue(reply);
    log(`Queued reply ${reply.id} still blocked by an in-progress turn; keeping it`);
    return;
  }
  log(`Queued reply ${reply.id} could not be injected (no active thread); dropping`);
  outboxRequester.delete(reply.id);
  emitToFrontends((to) => noticeMessage("reply_undeliverable", "\u26A0\uFE0F A reply you sent while Codex was busy could not be delivered \u2014 the Codex thread is gone. " + `Reconnect the Codex TUI and send it again.

Undelivered message:
${truncateForNotice(reply.content)}`, to));
  discardOutboxForLostCodex("the Codex thread is gone");
}
function discardOutboxForLostCodex(why) {
  const lost = replyOutbox.clear();
  if (lost.length === 0)
    return;
  log(`Discarding ${lost.length} queued Claude \u2192 Codex repl(ies): ${why}`);
  for (const r of lost)
    outboxRequester.delete(r.id);
  emitToFrontends((to) => noticeMessage("reply_discarded", `\u26A0\uFE0F ${lost.length} repl${lost.length > 1 ? "ies" : "y"} you sent while Codex was busy ` + `${lost.length > 1 ? "were" : "was"} never delivered \u2014 ${why}. ` + `Resend if still relevant.

` + lost.map((r, i) => `[${i + 1}] ${truncateForNotice(r.content)}`).join(`

`), to));
}
function truncateForNotice(content, max = 400) {
  return content.length <= max ? content : `${content.slice(0, max)}\u2026 (${content.length} chars total)`;
}
async function attachFrontend(ws, agent) {
  const label = `${agent} frontend`;
  const occupant = frontends.contestedBy(agent, ws);
  if (occupant) {
    const msSincePong = Date.now() - occupant.data.lastPongAt;
    log(`${label} contest: new=#${ws.data.clientId}, incumbent=#${occupant.data.clientId} ` + `(readyState=${occupant.readyState}, msSincePong=${msSincePong})`);
    if (frontends.isProbing(agent)) {
      log(`Rejecting ${label} #${ws.data.clientId} \u2014 another liveness probe already in flight`);
      ws.close(CLOSE_CODE_PROBE_IN_PROGRESS, "liveness probe in progress, retry shortly");
      return;
    }
    frontends.beginProbe(agent);
    let incumbentAlive = false;
    try {
      incumbentAlive = await probeLiveness2(occupant, LIVENESS_PROBE_TIMEOUT_MS);
    } finally {
      frontends.endProbe(agent);
    }
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      log(`Contestant #${ws.data.clientId} disappeared during probe \u2014 aborting`);
      if (!incumbentAlive) {
        evictStale(occupant, "contestant gone but probe still failed");
      }
      return;
    }
    if (incumbentAlive) {
      log(`Rejecting ${label} #${ws.data.clientId} \u2014 incumbent #${occupant.data.clientId} responded to liveness probe`);
      ws.close(CLOSE_CODE_REPLACED, `another ${agent} session is already connected`);
      return;
    }
    evictStale(occupant, `liveness probe timed out after ${LIVENESS_PROBE_TIMEOUT_MS}ms`);
  }
  const raced = frontends.contestedBy(agent, ws);
  if (raced) {
    log(`Rejecting ${label} #${ws.data.clientId} \u2014 slot re-acquired by #${raced.data.clientId} after probe`);
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
  sendProtocolMessage(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION });
  statusBuffer.flush(`${agent} reconnected`);
  sendStatus(ws);
  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;
  if (!isRapidReattach) {
    if (tuiConnectionState.canReply()) {
      transports.wake(agent, systemMessage("system_ready", currentReadyMessage(), agent), log);
    } else if (codexBootstrapped) {
      transports.wake(agent, systemMessage("system_waiting", currentWaitingMessage(), agent), log);
    }
  }
  lastAttachStatusSentTs = now;
  if (agent === DEFAULT_FRONTEND_AGENT && tuiConnectionState.canReply() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
}
function detachFrontend(ws, reason) {
  const agent = frontends.releaseSocket(ws);
  if (agent === null)
    return;
  ws.data.attached = false;
  log(`${agent} frontend detached (#${ws.data.clientId}, ${reason})`);
  if (agent === DEFAULT_FRONTEND_AGENT) {
    scheduleClaudeDisconnectNotification(ws.data.clientId);
  }
  scheduleIdleShutdown();
}
async function probeLiveness2(ws, timeoutMs) {
  return probeLiveness({
    get readyState() {
      return ws.readyState;
    },
    get pongCount() {
      return ws.data.pongCount;
    },
    ping: () => {
      ws.ping();
    }
  }, { timeoutMs, pollMs: LIVENESS_PROBE_POLL_MS });
}
function evictStale(ws, reason) {
  log(`Evicting stale ${ws.data.agent} frontend #${ws.data.clientId}: ${reason}`);
  detachFrontend(ws, `evicted: ${reason}`);
  try {
    ws.close(CLOSE_CODE_EVICTED_STALE, "stale frontend evicted by newer session");
  } catch (err) {
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
function checkExpiredRequests() {
  const expired = pendingRequests.expire(Date.now(), PENDING_REQUEST_TTL_MS);
  for (const req of expired) {
    log(`Reply required for ${req.messageId} expired after ${PENDING_REQUEST_TTL_MS}ms without a reply (requester: ${req.requester})`);
    routeOrLog(noticeMessage("reply_missing", `\u26A0\uFE0F ${agentLabel(req.responder)} did not send a reply before the reply-required window expired. You may want to retry or rephrase.`, req.requester));
  }
}
function hasLiveClients() {
  return frontends.size > 0 || tuiConnectionState.snapshot().tuiConnected || grok.tuiConnected;
}
function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (hasLiveClients())
    return;
  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if (hasLiveClients()) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle \u2014 no clients connected");
  }, IDLE_SHUTDOWN_MS);
}
function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}
function clearPendingClaudeDisconnect(reason) {
  if (!claudeDisconnectTimer)
    return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}
function scheduleClaudeDisconnectNotification(clientId) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;
    if (claudeSocket()) {
      log(`Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`);
      return;
    }
    if (!tuiConnectionState.canReply()) {
      log(`Suppressing Claude disconnect notification for client #${clientId} because Codex cannot reply`);
      return;
    }
    if (!claudeOnlineNoticeSent) {
      log(`Suppressing Claude disconnect notification for client #${clientId} because Claude was never announced online`);
      return;
    }
    codex.injectMessage("\u26A0\uFE0F Claude Code went offline. AgentBridge is still running in the background; it will reconnect automatically when Claude reopens.");
    claudeOnlineNoticeSent = false;
    claudeOfflineNoticeShown = true;
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}
function trySendBridgeMessage(ws, message, deliveryHint) {
  try {
    const egressMessage = forEgress(message, ws.data.protocolVersion);
    const payload = deliveryHint ? { type: "codex_to_claude", message: egressMessage, deliveryHint } : { type: "codex_to_claude", message: egressMessage };
    const result = ws.send(JSON.stringify(payload));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}
function sendStatus(ws) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}
function broadcastStatus() {
  for (const { socket } of frontends.writable()) {
    sendStatus(socket);
  }
}
function sendProtocolMessage(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    log(`Failed to send control message: ${err.message}`);
  }
}
function currentStatus() {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: [...mailboxes.values()].reduce((n, box) => n + box.size, 0) + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
    claudeAttached: frontends.isAttached(DEFAULT_FRONTEND_AGENT),
    attachedAgents: frontends.attachedAgents(),
    pendingReplyCount: replyOutbox.size,
    projectId: DAEMON_PROJECT_ID
  };
}
function currentWaitingMessage() {
  return `\u23F3 Waiting for Codex TUI to connect. Run in another terminal:
${attachCmd}`;
}
function currentReadyMessage() {
  return `\u2705 Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
}
function notifyCodexClaudeOnline() {
  const message = !codexCollaborationKickoffSent ? [
    "\uD83E\uDD1D Claude Code has connected via AgentBridge.",
    "You are now in a multi-agent collaboration session.",
    "When you receive a complex task, propose a division of labor to Claude.",
    "Claude can send you messages \u2014 they will appear as injected user messages.",
    "Respond naturally and Claude will receive your output via AgentBridge."
  ].join(`
`) : "\u2705 AgentBridge connected to Claude Code.";
  const delivered = codex.injectMessage(message);
  if (!delivered) {
    log("Deferred Claude-online notice to Codex \u2014 will retry after current turn completes");
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
function systemMessage(idPrefix, content, to) {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    from: "system",
    to,
    kind: "untagged",
    content,
    timestamp: Date.now()
  };
}
function noticeMessage(idPrefix, content, to) {
  return {
    id: `notice_${idPrefix}_${++nextSystemMessageId}`,
    from: "system",
    to,
    kind: "untagged",
    content: `[AgentBridge] ${content}`,
    timestamp: Date.now()
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
    pid: process.pid
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
  } catch (err) {
    log(`Failed to start Codex: ${err.message}`);
    notifyFrontends((to) => systemMessage("system_codex_start_failed", `\u274C AgentBridge failed to start Codex app-server: ${err.message}`, to));
    broadcastStatus();
  }
}
function shutdown(reason) {
  if (shuttingDown)
    return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
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
process.on("exit", () => {
  removePidFile();
  removeStatusFile();
});
var startupComplete = false;
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
  if (!startupComplete) {
    log("Exception happened during startup \u2014 the daemon never came up. Exiting 1.");
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});
function log(msg) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}
`;
  process.stderr.write(line);
  getRotatingLogger(stateDir.logFile).write(line);
}
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found \u2014 daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}
var controlPortHolder = await probeControlPort(CONTROL_PORT);
if (controlPortHolder.kind !== "free") {
  const detail = describeControlPortConflict(CONTROL_PORT, DAEMON_PROJECT_ID, controlPortHolder);
  for (const line of detail.split(`
`))
    log(line);
  process.exit(1);
}
writePidFile();
try {
  startControlServer();
} catch (err) {
  log(`Failed to start the control server on port ${CONTROL_PORT}: ${err?.message ?? err}`);
  removePidFile();
  process.exit(1);
}
pendingRequestsTimer = setInterval(checkExpiredRequests, PENDING_REQUEST_CHECK_INTERVAL_MS);
startupComplete = true;
try {
  grok.start();
} catch (err) {
  log(`Failed to open the Grok proxy socket: ${describeError2(err)}`);
}
bootCodex();
