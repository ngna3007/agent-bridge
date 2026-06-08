#!/usr/bin/env bun

// Opt-in gate: bridge-server is loaded by the agentbridge plugin in
// every Claude Code launch (the plugin manifest controls that, not
// our code). We only want to attach to the daemon when the session
// was started via `abg claude`, which sets AGENTBRIDGE_ACTIVE=1 in
// the child env. Without that flag, exit silently before importing
// any heavy modules or touching the network. This prevents stray
// `claude` / `claude -c` sessions from holding the daemon's single
// Claude slot and starving the actual `abg claude` session.
//
// Tests / CI override the gate by setting AGENTBRIDGE_ACTIVE=1 in
// their own environment.
if (process.env.AGENTBRIDGE_ACTIVE !== "1") {
  process.exit(0);
}

import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { getRotatingLogger } from "./log-rotator";
import { ConfigService } from "./config-service";
import { StatusLineWriter } from "./status-line-writer";
import { disabledReplyError, type BridgeDisabledReason } from "./bridge-disabled-state";
import {
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
} from "./control-protocol";
import type { BridgeMessage } from "./types";

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const claude = new ClaudeAdapter(stateDir.logFile);
const daemonClient = new DaemonClient(CONTROL_WS_URL);
const statusLine = new StatusLineWriter(stateDir);

let shuttingDown = false;
let daemonDisabled = false;
let daemonDisabledReason: BridgeDisabledReason | null = null;

// --- TUI kickoff tracking ---
let hasSeenTuiConnect = false;
let previousTuiConnected = false;

// --- Notification throttling for reconnect loops ---
const RECONNECT_NOTIFY_COOLDOWN_MS = 30_000; // Only notify once per 30s window
const DISABLED_RECOVERY_INTERVAL_MS = 5_000;
let lastDisconnectNotifyTs = 0;
let lastReconnectNotifyTs = 0;
let disabledRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let disabledRecoveryInFlight = false;
let disabledRecoveryAttempts = 0;

const DISABLED_RECOVERY_MAX_ATTEMPTS = 6;
const DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS = 1000;

claude.setReplySender(async (msg: BridgeMessage, requireReply?: boolean) => {
  if (msg.source !== "claude") {
    return { success: false, error: "Invalid message source" };
  }

  if (daemonDisabled) {
    return {
      success: false,
      error: disabledReplyError(daemonDisabledReason ?? "killed"),
    };
  }

  return daemonClient.sendReply(msg, requireReply);
});

/**
 * ANSI color helpers for statusbar tags. Most terminal statusbars
 * (tmux, screen, Claude Code's bottom bar) honor these. Anything
 * that strips ANSI degrades to the plain text inside the codes.
 *
 * Severity colors:
 *   - GREEN  = healthy / ready
 *   - YELLOW = transient / working (don't act until it settles)
 *   - RED    = error / disconnected (something needs attention)
 *   - DIM    = quiesced / stopped on purpose
 *
 * We always pair the color code with a RESET so the colorization
 * never leaks past our tag into whatever the user's other statusLine
 * tools print (caveman, git branch, etc.).
 */
const C_RESET  = "\x1b[0m";
const C_GREEN  = "\x1b[32m";
const C_YELLOW = "\x1b[33m";
const C_RED    = "\x1b[31m";
const C_DIM    = "\x1b[2m";
const wrap = (c: string, s: string): string => `${c}${s}${C_RESET}`;

// Map daemon-side system_* notifications to plain-English statusbar
// strings so they don't bloat Claude's context. The MCP channel only
// carries Codex's real agentMessage replies; anything system-tagged
// from the daemon is treated as a lifecycle event and routed to
// status.line.
const DAEMON_LIFECYCLE_TAGS: Record<string, string> = {
  system_ready:              wrap(C_GREEN,  "[CODEX READY]"),
  system_waiting:            wrap(C_YELLOW, "[WAITING FOR CODEX]"),
  system_codex_start_failed: wrap(C_RED,    "[CODEX FAILED]"),
  system_turn_started:       wrap(C_YELLOW, "[CODEX THINKING]"),
  system_turn_completed:     wrap(C_GREEN,  "[CODEX READY]"),
  system_reply_missing:      wrap(C_RED,    "[CODEX NO REPLY]"),
  // Codex TUI dropped but daemon + codex app-server still alive.
  // Yellow because it's recoverable: user just reopens `abg codex`.
  system_tui_disconnected:   wrap(C_YELLOW, "[CODEX UI OFFLINE]"),
  system_tui_reconnected:    wrap(C_GREEN,  "[CODEX READY]"),
};

daemonClient.on("codexMessage", (message, deliveryHint) => {
  const tag = isDaemonLifecycle(message.id);
  if (tag) {
    log(`Daemon lifecycle event ${message.id} → status.line`);
    statusLine.write(tag);
    return;
  }
  if (deliveryHint === "queue") {
    // Untagged Codex output: hold in the adapter's pull queue.
    // Claude only sees it on the next get_messages call.
    log(`Queueing daemon → Claude (${message.content.length} chars)`);
    claude.enqueueForPull(message);
    return;
  }
  log(`Pushing daemon → Claude (${message.content.length} chars)`);
  void claude.pushNotification(message);
});

function isDaemonLifecycle(id: string): string | null {
  // Daemon-side BridgeMessage ids are formatted as "<prefix>_<ts>",
  // e.g. "system_waiting_1717000000000". Extract the prefix portion
  // (everything before the trailing _<digits>) and look it up.
  const match = /^([a-z_]+?)_\d+$/.exec(id);
  if (!match) return null;
  const prefix = match[1];
  if (prefix in DAEMON_LIFECYCLE_TAGS) {
    return DAEMON_LIFECYCLE_TAGS[prefix];
  }
  // Unknown system_* prefix: still treat as lifecycle so it doesn't
  // leak into Claude's chat. Fall back to a sanitized tag.
  if (prefix.startsWith("system_")) {
    return `[${prefix.replace(/^system_/, "").toUpperCase()}]`;
  }
  return null;
}

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );

  // Kickoff message on first TUI connect transition (not reconnects)
  if (!hasSeenTuiConnect && status.tuiConnected && !previousTuiConnected) {
    hasSeenTuiConnect = true;
    log("First TUI connect detected");
    emitLifecycle("system_tui_kickoff");
  }
  previousTuiConnected = status.tuiConnected;
});

daemonClient.on("disconnect", () => {
  if (shuttingDown || daemonDisabled) return;

  log("Daemon control connection closed — will attempt to reconnect");

  const now = Date.now();
  if (now - lastDisconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
    lastDisconnectNotifyTs = now;
    emitLifecycle("system_daemon_disconnected");
  } else {
    log("Suppressing duplicate disconnect statusbar update (within cooldown)");
  }
  void reconnectToDaemon();
});

daemonClient.on("rejected", async (code: number) => {
  if (shuttingDown || daemonDisabled) return;

  let reason: BridgeDisabledReason;
  let notificationId: string;
  switch (code) {
    case CLOSE_CODE_EVICTED_STALE:
      reason = "evicted";
      notificationId = "system_bridge_evicted";
      break;
    case CLOSE_CODE_PROBE_IN_PROGRESS:
      reason = "probe_in_progress";
      notificationId = "system_bridge_probe_in_progress";
      break;
    default:
      reason = "rejected";
      notificationId = "system_bridge_replaced";
      break;
  }
  log(`Daemon rejected this session (close code ${code}, reason=${reason})`);

  // Eviction and replacement are terminal until the user intervenes: the
  // legitimate new session must not be kicked out by an auto-reconnect. But
  // probe_in_progress is transient by definition (the probe resolves within
  // LIVENESS_PROBE_TIMEOUT_MS, default 3s), so we start the recovery poller
  // and let it auto-reconnect once the slot becomes available.
  daemonDisabled = true;
  daemonDisabledReason = reason;
  emitLifecycle(notificationId);
  await daemonClient.disconnect();
  if (reason === "probe_in_progress") {
    disabledRecoveryAttempts = 0;
    startDisabledRecoveryPoller();
  }
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring AgentBridge daemon...`);
  if (daemonLifecycle.wasKilled()) {
    await enterDisabledState("Killed sentinel found — bridge staying idle");
    return;
  }
  await connectToDaemon();
});

async function connectToDaemon(isReconnect = false) {
  if (daemonDisabled) {
    log("connectToDaemon() skipped — bridge is disabled");
    return;
  }

  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    daemonClient.attachClaude();
    daemonDisabledReason = null;
    if (!isReconnect) {
      emitLifecycle("system_bridge_ready");
    }
  } catch (err: any) {
    log(`Failed to connect to daemon: ${err.message}`);
    emitLifecycle("system_daemon_connect_failed");
    throw err;
  }
}

async function enterDisabledState(logMessage: string) {
  if (daemonDisabled) return;

  daemonDisabled = true;
  daemonDisabledReason = "killed";
  log(logMessage);
  emitLifecycle("system_bridge_disabled");
  await daemonClient.disconnect();
  startDisabledRecoveryPoller();
}

const MAX_RECONNECT_DELAY_MS = 30_000;
let reconnectTask: Promise<void> | null = null;

async function notifyIfDaemonKilled(logMessage: string) {
  if (!daemonLifecycle.wasKilled()) return false;

  await enterDisabledState(logMessage);
  return true;
}

function reconnectToDaemon(): Promise<void> {
  if (shuttingDown || daemonDisabled) return Promise.resolve();

  if (reconnectTask) {
    log("Skipping reconnect — another reconnect is already in progress");
    return reconnectTask;
  }

  reconnectTask = (async () => {
    try {
      for (let attempt = 0; !shuttingDown; attempt += 1) {
        if (await notifyIfDaemonKilled("Daemon was intentionally killed by user (killed sentinel found) — not reconnecting")) {
          return;
        }

        const delayMs = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        if (attempt > 0) {
          log(`Reconnect attempt ${attempt + 1}, waiting ${delayMs}ms...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (shuttingDown) return;

        // Re-check after the backoff delay. The killed sentinel may be written
        // after the disconnect event fires but before the reconnect attempt runs.
        if (await notifyIfDaemonKilled("Daemon was intentionally killed during reconnect backoff — not reconnecting")) {
          return;
        }

        try {
          await connectToDaemon(true);
          log("Reconnected to AgentBridge daemon successfully");

          const now = Date.now();
          if (now - lastReconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
            lastReconnectNotifyTs = now;
            emitLifecycle("system_daemon_reconnected");
          } else {
            log("Suppressing duplicate reconnect statusbar update (within cooldown)");
          }
          return;
        } catch {
          // Continue retrying with exponential backoff until shutdown or killed sentinel.
        }
      }
    } finally {
      reconnectTask = null;
    }
  })();

  return reconnectTask;
}

function startDisabledRecoveryPoller() {
  if (disabledRecoveryTimer || shuttingDown) return;

  log(`Starting disabled-state recovery poller (${DISABLED_RECOVERY_INTERVAL_MS}ms)`);
  disabledRecoveryTimer = setInterval(() => {
    void pollDisabledRecovery();
  }, DISABLED_RECOVERY_INTERVAL_MS);
}

function stopDisabledRecoveryPoller() {
  if (!disabledRecoveryTimer) return;

  clearInterval(disabledRecoveryTimer);
  disabledRecoveryTimer = null;
  disabledRecoveryInFlight = false;
  log("Stopped disabled-state recovery poller");
}

async function pollDisabledRecovery() {
  if (!daemonDisabled || shuttingDown || disabledRecoveryInFlight) return;

  disabledRecoveryInFlight = true;
  try {
    if (daemonLifecycle.wasKilled()) {
      return;
    }

    const healthy = await daemonLifecycle.isHealthy();
    if (!healthy) {
      return;
    }

    const recoveredFrom = daemonDisabledReason;
    switch (recoveredFrom) {
      case "probe_in_progress": {
        if (disabledRecoveryAttempts >= DISABLED_RECOVERY_MAX_ATTEMPTS) {
          log(
            `Disabled-state auto-recovery gave up after ${DISABLED_RECOVERY_MAX_ATTEMPTS} attempts ` +
            "— switching to auto_recovery_exhausted terminal state",
          );
          daemonDisabledReason = "auto_recovery_exhausted";
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          emitLifecycle("system_bridge_auto_recovery_gave_up");
          return;
        }

        disabledRecoveryAttempts += 1;
        log(
          `Disabled-state recovery attempt ${disabledRecoveryAttempts}/${DISABLED_RECOVERY_MAX_ATTEMPTS} ` +
          "for probe_in_progress — attempting direct daemon reconnect",
        );

        try {
          await daemonClient.connect();
          const attached = await daemonClient.attachClaudeAndWaitForStatus(
            DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS,
          );
          if (!attached) {
            log(
              `Disabled-state probe_in_progress recovery attempt ${disabledRecoveryAttempts} did not confirm readiness`,
            );
            await daemonClient.disconnect();
            return;
          }

          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          // We're inside the `probe_in_progress` case branch — TS has narrowed
          // recoveredFrom to that single value, so use the matching message
          // directly. The outer switch (with its `never` exhaustive default)
          // is what enforces compile-time coverage of every BridgeDisabledReason.
          emitLifecycle("system_bridge_recovered");
        } catch (err: any) {
          log(`Disabled-state probe_in_progress recovery attempt failed: ${err.message}`);
          await daemonClient.disconnect();
        }
        return;
      }
      case "killed": {
        log("Disabled-state recovery conditions met — attempting direct daemon reconnect");
        try {
          await daemonClient.connect();
          const attached = await daemonClient.attachClaudeAndWaitForStatus(
            DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS,
          );
          if (!attached) {
            throw new Error("daemon did not confirm reconnect");
          }

          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          emitLifecycle("system_bridge_recovered");
        } catch (err: any) {
          log(`Disabled-state direct reconnect failed: ${err.message}`);
          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          void reconnectToDaemon();
        }
        return;
      }
      case "evicted":
      case "rejected":
      case "auto_recovery_exhausted":
      case null:
        log(
          `Disabled-state recovery poller encountered terminal/unexpected reason ${recoveredFrom ?? "null"} — stopping`,
        );
        stopDisabledRecoveryPoller();
        return;
      default: {
        const exhaustive: never = recoveredFrom;
        return exhaustive;
      }
    }
  } finally {
    disabledRecoveryInFlight = false;
  }
}

/**
 * Map every lifecycle event id to a plain-English colored statusbar
 * string.
 *
 * The MCP channel is reserved for Codex's actual agentMessage replies;
 * every bridge / daemon / TUI state change goes only to the status.line
 * file. Users (or their statusLine shell command) read it to know
 * "what's the link doing right now".
 *
 * Tags are written for non-developers: no all-caps codenames, no
 * jargon like "evicted" or "probing". When the situation is
 * actionable, the tag tells the user what to type.
 */
const LIFECYCLE_TAGS: Record<string, string> = {
  system_tui_kickoff:                   wrap(C_GREEN,  "[CODEX READY]"),
  system_daemon_disconnected:           wrap(C_RED,    "[BRIDGE OFFLINE]"),
  system_daemon_reconnected:            wrap(C_GREEN,  "[CODEX READY]"),
  system_bridge_ready:                  wrap(C_GREEN,  "[BRIDGE READY]"),
  system_daemon_connect_failed:         wrap(C_RED,    "[BRIDGE FAILED]"),
  system_bridge_evicted:                wrap(C_RED,    "[REPLACED BY NEWER SESSION]"),
  system_bridge_probe_in_progress:      wrap(C_YELLOW, "[RECONNECTING]"),
  system_bridge_replaced:               wrap(C_RED,    "[ANOTHER SESSION ACTIVE]"),
  system_bridge_disabled:               wrap(C_DIM,    "[BRIDGE STOPPED]"),
  system_bridge_auto_recovery_gave_up:  wrap(C_RED,    "[RECONNECT FAILED]"),
  system_bridge_recovered:              wrap(C_GREEN,  "[CODEX READY]"),
};

/**
 * Write a lifecycle event to status.line. Never touches the MCP
 * channel: only Codex's own replies cross that boundary. If the id is
 * unknown we fall back to a sanitized version of it so a missing tag
 * never breaks the statusbar.
 */
function emitLifecycle(idPrefix: string): void {
  const tag = LIFECYCLE_TAGS[idPrefix] ?? `[${idPrefix.replace(/^system_/, "").toUpperCase()}]`;
  statusLine.write(tag);
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down Claude frontend (${reason})...`);
  stopDisabledRecoveryPoller();
  const hardExit = setTimeout(() => {
    log("Shutdown timed out waiting for daemon disconnect; forcing exit");
    process.exit(0);
  }, 3000);

  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("exit", () => {
  if (shuttingDown) return;
  void daemonClient.disconnect();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeFrontend] ${msg}\n`;
  process.stderr.write(line);
  getRotatingLogger(stateDir.logFile).write(line);
}

log(`Starting AgentBridge frontend (daemon ws ${CONTROL_WS_URL})`);

(async () => {
  try {
    await claude.start();
  } catch (err: any) {
    log(`Fatal: failed to start MCP server: ${err.message}`);
  }
})();
