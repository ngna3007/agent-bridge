import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle, isProcessAlive } from "../daemon-lifecycle";
import {
  enumerateStateDirs,
  findOrphanBridgeServers,
  gracefulKill,
} from "../process-helpers";

export interface KillOptions {
  /** When true, sweep every project state dir under the platform root. */
  all?: boolean;
}

export async function runKill(args: string[] = []) {
  const opts: KillOptions = {
    all: args.includes("--all"),
  };

  if (opts.all) {
    return runKillAll();
  }

  console.log("AgentBridge Kill — stopping daemon and managed Codex TUI\n");

  const stateDir = new StateDirResolver();
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
  const log = (msg: string) => console.log(`  ${msg}`);

  const lifecycle = new DaemonLifecycle({ stateDir, controlPort, log });

  // Mark the daemon as intentionally stopped before terminating the process.
  // This closes the reconnect race where the frontend sees the disconnect
  // before the sentinel is written and relaunches the daemon.
  lifecycle.markKilled();
  const tuiKilled = await killManagedCodexTui(stateDir, log);
  const killed = await lifecycle.kill();
  const reaped = await reapOrphans(stateDir, controlPort, log);

  if (killed || tuiKilled || reaped > 0) {
    console.log("\nAgentBridge stopped.");
    console.log("Please restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to fully disconnect.");
  } else {
    console.log("\nNo running AgentBridge daemon or managed Codex TUI found.");
    console.log("Stale state files cleaned up (if any).");
  }
}

/**
 * Sweep every project state dir under the platform root, stopping
 * whatever's running. Used when the user has multiple projects and
 * just wants "kill everything AgentBridge-related".
 */
async function runKillAll() {
  console.log("AgentBridge Kill (--all) — sweeping every project state dir\n");
  // For --all we ignore any AGENTBRIDGE_STATE_DIR override and use
  // the platform default root, then enumerate per-project subdirs
  // under it. This is the only way to find sibling projects we
  // weren't launched in.
  const prevStateDir = process.env.AGENTBRIDGE_STATE_DIR;
  delete process.env.AGENTBRIDGE_STATE_DIR;
  const stateRoot = new StateDirResolver().dir;
  if (prevStateDir !== undefined) process.env.AGENTBRIDGE_STATE_DIR = prevStateDir;

  const dirs = enumerateStateDirs(stateRoot);
  if (dirs.length === 0) {
    console.log("No AgentBridge state directories found under " + stateRoot);
    return;
  }

  let totalKilled = 0;
  for (const dir of dirs) {
    console.log(`\n[${dir}]`);
    const sd = new StateDirResolver(dir);
    // Best-effort: control port for the root may not match; we read
    // the daemon-status file if present to pick the right port.
    const controlPort = readControlPortFromStatus(dir) ?? 4502;
    const log = (msg: string) => console.log(`  ${msg}`);

    const lifecycle = new DaemonLifecycle({ stateDir: sd, controlPort, log });
    lifecycle.markKilled();
    const tuiKilled = await killManagedCodexTui(sd, log);
    const killed = await lifecycle.kill();
    const reaped = await reapOrphans(sd, controlPort, log);
    if (killed || tuiKilled || reaped > 0) totalKilled++;
  }

  console.log(`\nDone. ${totalKilled} project state dir(s) had something to stop.`);
}

/**
 * Send SIGTERM to bridge-server.js processes whose env points at
 * this state dir. These are typically orphans from a Claude Code
 * session that died without notifying the daemon, and they keep
 * trying to start a daemon - which blocks `abg codex` next time.
 *
 * Intentionally NOT port-based: a port-binding lookup is too
 * aggressive and risks killing unrelated processes that happen to
 * sit on a colliding port. Env matching is precise.
 */
async function reapOrphans(
  stateDir: StateDirResolver,
  _controlPort: number,
  log: (msg: string) => void,
): Promise<number> {
  let reaped = 0;
  const bridges = findOrphanBridgeServers(stateDir.dir);
  for (const pid of bridges) {
    if (pid === process.pid) continue;
    log(`Reaping orphan bridge-server pid ${pid}`);
    if (await gracefulKill(pid)) reaped++;
  }
  return reaped;
}

function readControlPortFromStatus(stateDir: string): number | null {
  try {
    const raw = readFileSync(`${stateDir}/status.json`, "utf-8");
    const parsed = JSON.parse(raw) as { controlPort?: number };
    return parsed.controlPort ?? null;
  } catch {
    return null;
  }
}

async function killManagedCodexTui(
  stateDir: StateDirResolver,
  log: (msg: string) => void,
  gracefulTimeoutMs = 3000,
): Promise<boolean> {
  const pid = readTuiPid(stateDir);
  if (!pid) {
    log("No Codex TUI pid file found");
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isProcessAlive(pid)) {
    log(`Codex TUI pid ${pid} is not alive, cleaning up stale pid file`);
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isManagedCodexTuiProcess(pid)) {
    log(`Pid ${pid} is alive but is NOT a managed AgentBridge Codex TUI — refusing to kill. Cleaning up stale pid file.`);
    removeTuiPidFile(stateDir);
    return false;
  }

  log(`Sending SIGTERM to Codex TUI pid ${pid}`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removeTuiPidFile(stateDir);
    return false;
  }

  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      log(`Codex TUI pid ${pid} stopped gracefully`);
      removeTuiPidFile(stateDir);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log(`Codex TUI pid ${pid} did not stop gracefully, sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  removeTuiPidFile(stateDir);
  return true;
}

function readTuiPid(stateDir: StateDirResolver): number | null {
  try {
    const raw = readFileSync(stateDir.tuiPidFile, "utf-8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removeTuiPidFile(stateDir: StateDirResolver) {
  try {
    unlinkSync(stateDir.tuiPidFile);
  } catch {}
}

function isManagedCodexTuiProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
    return (
      cmd.includes("codex")
      && cmd.includes("--enable")
      && cmd.includes("tui_app_server")
      && cmd.includes("--remote")
    );
  } catch {
    return false;
  }
}
