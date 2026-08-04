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

claude.setMailbox({
  drain: () => daemonClient.drain(),
  ack: (batchId, ids) => daemonClient.ack(batchId, ids),
});

claude.setReplySender(async (msg: BridgeMessage, requireReply?: boolean) => {
  // The `msg.source !== "claude"` check that used to live here was
  // client-side — in the very process that would be doing the spoofing.
  // Attribution is now derived from the authenticated socket by
  // normalizeIngress on the daemon side.
  if (daemonDisabled) {
    return {
      success: false,
      error: disabledReplyError(daemonDisabledReason ?? "killed"),
    };
  }

  return daemonClient.sendReply(msg, requireReply);
});

// Statusbar tags + colors live in src/lifecycle-tags.ts so daemon.ts
// (which writes [BRIDGE STOPPED] on shutdown) can never drift from
// what bridge.ts emits.
import { tagForLifecycle } from "./lifecycle-tags";

daemonClient.on("codexMessage", (message) => {
  const tag = isDaemonLifecycle(message.id);
  if (tag) {
    log(`Daemon lifecycle event ${message.id} → status.line`);
    statusLine.write(tag);
    return;
  }
  // A push is a wake-up. It never consumes — the message stays in the
  // daemon's mailbox until an ack, so a channel that silently drops it
  // costs latency rather than the message. The daemon's delivery hint
  // no longer changes this: every non-lifecycle message wakes Claude,
  // and get_messages is what actually drains the mailbox.
  log(`Waking Claude for ${message.id} (${message.content.length} chars)`);
  void claude.pushNotification(message);
});

function isDaemonLifecycle(id: string): string | null {
  // Daemon-side BridgeMessage ids are formatted as "<prefix>_<ts>",
  // e.g. "system_waiting_1717000000000". Extract the prefix portion
  // and look it up in the shared tag table. Anything system_* falls
  // back to a sanitized auto-uppercased tag so a new event id can
  // never silently leak into Claude's chat.
  const match = /^([a-z_]+?)_\d+$/.exec(id);
  if (!match) return null;
  const prefix = match[1];
  if (!prefix.startsWith("system_")) return null;
  return tagForLifecycle(prefix);
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
 * Write a lifecycle event to status.line. Never touches the MCP
 * channel: only Codex's own replies cross that boundary. Tags come
 * from the shared src/lifecycle-tags.ts table so daemon.ts and
 * bridge.ts cannot drift.
 */
function emitLifecycle(idPrefix: string): void {
  statusLine.write(tagForLifecycle(idPrefix));
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
