/**
 * `abg projects` - list every project (state dir) under the platform
 * default root, with its daemon state. Read-only.
 *
 * Output is one row per state dir:
 *   <projectId>  <state>  <statusbar tag>  <state dir>
 *
 * For the legacy single-instance state dir (no projectId subdir), the
 * id column shows `default`. Helps the user remember which project
 * owns which slot when several daemons run in parallel.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { StateDirResolver } from "../state-dir";
import { enumerateStateDirs, isPidAlive } from "../process-helpers";

interface ProjectRow {
  id: string;
  stateDir: string;
  daemonState: "running" | "stale" | "stopped" | "not-running";
  pid: number | null;
  tag: string;
}

export async function runProjects() {
  // Use the platform default root regardless of any env override.
  const prev = process.env.AGENTBRIDGE_STATE_DIR;
  delete process.env.AGENTBRIDGE_STATE_DIR;
  const root = new StateDirResolver().dir;
  if (prev !== undefined) process.env.AGENTBRIDGE_STATE_DIR = prev;

  const dirs = enumerateStateDirs(root);
  if (dirs.length === 0) {
    console.log("No AgentBridge state directories found.");
    console.log(`Looked under: ${root}`);
    console.log("");
    console.log(`Run \`abg init\` inside a project root to opt that project into per-project namespacing.`);
    return;
  }

  const rows: ProjectRow[] = dirs.map((dir) => readProjectRow(dir, root));

  // Sort: running first, then stale, then stopped/none. Alphabetical
  // by id within each state.
  const order = { running: 0, stale: 1, stopped: 2, "not-running": 3 } as const;
  rows.sort((a, b) => order[a.daemonState] - order[b.daemonState] || a.id.localeCompare(b.id));

  console.log("AgentBridge projects\n");
  console.log(formatRow("ID", "STATE", "TAG", "DIRECTORY"));
  console.log("-".repeat(80));
  for (const row of rows) {
    const stateCol = formatState(row.daemonState, row.pid);
    console.log(formatRow(row.id, stateCol, row.tag, row.stateDir));
  }
  console.log("");
  console.log(`Tip: \`abg status\` shows full details for the current project.`);
  console.log(`     \`abg kill --all\` stops every daemon listed above.`);
}

function readProjectRow(stateDir: string, root: string): ProjectRow {
  const id = stateDir === root ? "default" : basename(stateDir);
  const pidPath = join(stateDir, "daemon.pid");
  const statusLinePath = join(stateDir, "status.line");
  const killedSentinel = join(stateDir, "killed");

  let pid: number | null = null;
  if (existsSync(pidPath)) {
    try {
      pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isFinite(pid)) pid = null;
    } catch {
      pid = null;
    }
  }

  let daemonState: ProjectRow["daemonState"];
  if (pid && isPidAlive(pid)) {
    daemonState = "running";
  } else if (pid) {
    daemonState = "stale";
  } else if (existsSync(killedSentinel)) {
    daemonState = "stopped";
  } else {
    daemonState = "not-running";
  }

  let tag = "-";
  if (existsSync(statusLinePath)) {
    try {
      const raw = readFileSync(statusLinePath, "utf-8").replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (raw) tag = raw;
    } catch {
      /* ignore */
    }
  }

  return { id, stateDir, daemonState, pid, tag };
}

function formatRow(id: string, state: string, tag: string, dir: string): string {
  return `${id.padEnd(10)} ${state.padEnd(18)} ${tag.padEnd(28)} ${dir}`;
}

function formatState(state: ProjectRow["daemonState"], pid: number | null): string {
  switch (state) {
    case "running":
      return `running (${pid})`;
    case "stale":
      return `stale (${pid})`;
    case "stopped":
      return "stopped (kill)";
    case "not-running":
      return "not running";
  }
}
