import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StateDirResolver } from "../state-dir";
import { resolveProject } from "../project-id";

interface DaemonStatusFile {
  proxyUrl?: string;
  appServerUrl?: string;
  controlPort?: number;
  pid?: number;
}

/**
 * Report what AgentBridge knows about the current project + daemon
 * state. Read-only, no side effects, no network calls - this command
 * is meant to be safe to spam when the user is debugging "why didn't
 * my session attach?".
 */
export async function runStatus() {
  const project = resolveProject();
  const stateDir = new StateDirResolver();

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
  if (pid && isProcessAlive(pid)) {
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

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0: no-op except permission check. Throws ESRCH if dead.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
