import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeNamespace } from "../runtime-namespace";
import { isPidAlive } from "../process-helpers";
import type { DaemonStatus } from "../control-protocol";

interface DaemonStatusFile {
  proxyUrl?: string;
  appServerUrl?: string;
  controlPort?: number;
  pid?: number;
}

/**
 * How long to wait for the daemon's /healthz before giving up and
 * printing the file-derived view alone. Short on purpose: the daemon is
 * on loopback, so anything slower than this means it is wedged, and a
 * status command that hangs is worse than one that says less.
 */
const LIVE_STATUS_TIMEOUT_MS = 1500;

/**
 * Report what AgentBridge knows about the current project + daemon
 * state. Read-only and safe to spam when the user is debugging "why
 * didn't my session attach?".
 *
 * The daemon is asked directly when it is running. Files on disk only
 * record what was true at boot, so the file-only version of this
 * command could not answer the question people actually open it for —
 * is the *other* agent attached right now? A running daemon has always
 * known that; it was simply never asked.
 */
export async function runStatus() {
  // Read-only: we never mutate env here. resolveRuntimeNamespace
  // returns the same stateDir the runtime would use, including the
  // per-project subdir when .agentbridge/ is set up.
  const ns = resolveRuntimeNamespace({ mutateEnv: false });
  const project = ns.project;
  const stateDir = ns.stateDir;

  console.log("AgentBridge status\n");

  // Project block
  if (project) {
    console.log("Project");
    console.log(`  id          ${project.projectId}`);
    console.log(`  root        ${project.rootPath}`);
    console.log(`  codex port  ${project.ports.codexWs}`);
    console.log(`  proxy port  ${project.ports.codexProxy}`);
    console.log(`  control     ${project.ports.control}`);
  } else {
    console.log("Project");
    console.log("  (no .agentbridge/ marker in this directory or any ancestor)");
    console.log("  Single-instance mode: control 4502, codex 4500, proxy 4501.");
    console.log("  Run `abg init` here to opt this project into multi-project mode.");
  }
  console.log("");

  // Daemon block
  console.log("Daemon");
  console.log(`  state dir   ${stateDir.dir}`);

  const pidPath = join(stateDir.dir, "daemon.pid");
  const statusPath = join(stateDir.dir, "status.json");
  const statusLinePath = join(stateDir.dir, "status.line");
  const killedSentinel = join(stateDir.dir, "killed");
  const lockPath = join(stateDir.dir, "startup.lock");

  const pidStr = readIfExists(pidPath);
  const pid = pidStr ? parseInt(pidStr, 10) : null;
  if (pid && isPidAlive(pid)) {
    console.log(`  status      running (pid ${pid})`);
  } else if (pid) {
    console.log(`  status      stale pid ${pid} (process is gone; run \`abg kill\` to clean up)`);
  } else if (existsSync(lockPath)) {
    console.log(`  status      starting (lock present)`);
  } else if (existsSync(killedSentinel)) {
    console.log(`  status      stopped (killed sentinel present)`);
  } else {
    console.log(`  status      not running`);
  }

  const statusJson = readIfExists(statusPath);
  if (statusJson) {
    try {
      const parsed = JSON.parse(statusJson) as DaemonStatusFile;
      if (parsed.proxyUrl) console.log(`  proxy url   ${parsed.proxyUrl}`);
      if (parsed.appServerUrl) console.log(`  app-server  ${parsed.appServerUrl}`);
      if (parsed.controlPort) console.log(`  control     ${parsed.controlPort}`);
    } catch {
      /* ignore */
    }
  }

  const statusLine = readIfExists(statusLinePath);
  if (statusLine) {
    // status.line content has an ANSI color wrap; strip for display.
    const clean = statusLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (clean) console.log(`  last tag    ${clean}`);
  }
  console.log("");

  // Live block — only meaningful while a daemon is actually up.
  const controlPort = resolveControlPort(ns, statusPath);
  const live = pid && isPidAlive(pid) && controlPort ? await fetchLiveStatus(controlPort) : null;

  if (live) {
    console.log("Live");
    console.log(`  claude      ${live.claudeAttached ? "attached" : "not attached"}`);
    // Only shown when there is one, so a single-agent session reads
    // exactly as it did before frontends were keyed by identity. `?? []`
    // covers a pre-0.8 daemon still running under a newer CLI.
    const others = (live.attachedAgents ?? []).filter((agent) => agent !== "claude");
    if (others.length > 0) {
      console.log(`  also        ${others.join(", ")} attached`);
    }
    console.log(`  codex tui   ${live.tuiConnected ? "connected" : "not connected"}`);
    console.log(`  thread      ${live.threadId ?? "none yet (Codex has not started a thread)"}`);
    console.log(`  bridge      ${live.bridgeReady ? "ready" : "not ready"}`);
    console.log(`  queued      ${live.queuedMessageCount} Codex message(s) waiting for get_messages`);
    console.log(`  held        ${live.pendingReplyCount} Claude repl(ies) waiting for Codex's turn to end`);
    console.log("");

    const hints = liveHints(live);
    if (hints.length > 0) {
      for (const hint of hints) console.log(hint);
      console.log("");
    }
  } else if (pid && isPidAlive(pid)) {
    console.log("Live");
    console.log("  (daemon did not answer /healthz — it may be starting or wedged)");
    console.log("  Run `abg doctor` to diagnose, or `abg kill` to restart it.");
    console.log("");
  }

  // Env block - help when the user has manually overridden anything.
  const overrides = [
    "AGENTBRIDGE_CONTROL_PORT",
    "CODEX_WS_PORT",
    "CODEX_PROXY_PORT",
    "AGENTBRIDGE_STATE_DIR",
    "AGENTBRIDGE_MODE",
  ]
    .map((k) => [k, process.env[k]] as const)
    .filter(([, v]) => v !== undefined);
  if (overrides.length > 0) {
    console.log("Env overrides");
    for (const [k, v] of overrides) console.log(`  ${k}=${v}`);
    console.log("");
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Which port to ask. The derived project port is the right answer
 * almost always, but `status.json` wins when it disagrees: it records
 * the port the *running* daemon actually bound, and a config edit or a
 * moved project root can leave the derivation pointing elsewhere. Using
 * the derived port there would report "not answering" about a daemon
 * that is perfectly healthy one port over.
 */
function resolveControlPort(
  ns: { project: { ports: { control: number } } | null },
  statusPath: string,
): number | null {
  const statusJson = readIfExists(statusPath);
  if (statusJson) {
    try {
      const parsed = JSON.parse(statusJson) as DaemonStatusFile;
      if (typeof parsed.controlPort === "number") return parsed.controlPort;
    } catch {
      /* fall through to the derived port */
    }
  }
  if (ns.project) return ns.project.ports.control;
  const fromEnv = process.env.AGENTBRIDGE_CONTROL_PORT;
  if (fromEnv) {
    const parsed = parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 4502; // single-instance fallback, matches runtime-namespace
}

/**
 * Ask the daemon for its own view. Every failure mode — refused,
 * timed out, non-200, unparseable — collapses to null, because the
 * caller's job is to fall back to the file view, not to explain HTTP.
 */
async function fetchLiveStatus(controlPort: number): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/healthz`, {
      signal: AbortSignal.timeout(LIVE_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

/**
 * Turn the live numbers into the next thing to do.
 *
 * A status command that only prints state makes the reader derive the
 * diagnosis. These are the four states that actually stall a session,
 * each paired with the command that clears it.
 */
function liveHints(live: DaemonStatus): string[] {
  const hints: string[] = [];
  if (!live.claudeAttached && !live.tuiConnected) {
    hints.push("Neither side is attached. Start `abg claude` in one terminal and `abg codex` in another.");
  } else if (!live.claudeAttached) {
    hints.push("Codex is connected but Claude is not. Run `abg claude` to attach this project's Claude session.");
  } else if (!live.tuiConnected) {
    hints.push("Claude is attached but the Codex TUI is not. Run `abg codex` in another terminal.");
  } else if (!live.threadId) {
    hints.push("Both sides are attached but Codex has no thread yet. Send one message in the Codex TUI to start it.");
  }
  if (live.pendingReplyCount > 0) {
    hints.push(
      `${live.pendingReplyCount} Claude repl${live.pendingReplyCount > 1 ? "ies are" : "y is"} held until Codex's current turn ends. This is normal; no action needed.`,
    );
  }
  if (live.queuedMessageCount > 0) {
    hints.push(`${live.queuedMessageCount} Codex message(s) are queued for Claude's next get_messages call.`);
  }
  return hints;
}

