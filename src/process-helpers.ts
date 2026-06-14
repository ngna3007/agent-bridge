/**
 * Process-discovery helpers used by `abg kill`, `abg projects`, and
 * `abg doctor`. All helpers are best-effort: they return empty arrays
 * on any system-level failure (missing /proc, ps not available,
 * permission denied) instead of throwing, so the caller can keep
 * making forward progress on partial information.
 *
 * The mechanisms here are intentionally Unix-flavored - macOS and
 * Linux are the supported targets. On Linux we prefer /proc which is
 * fast and authoritative; on macOS we shell out to `ps -E`. Windows
 * is not covered.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

/**
 * Return the pids of processes whose environment contains
 * `<envKey>=<envValue>` exactly. Empty array on any error.
 *
 * Linux path: walks /proc/<pid>/environ (NUL-separated env). Fast
 * (no fork) and works without ps. macOS path: `ps -Eo pid,command`,
 * which prepends the env to the command line.
 */
export function findPidsByEnv(envKey: string, envValue: string): number[] {
  const pids: number[] = [];
  const needle = `${envKey}=${envValue}`;

  if (existsSync("/proc")) {
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = parseInt(name, 10);
        try {
          const env = readFileSync(`/proc/${pid}/environ`, "utf-8");
          // /proc/<pid>/environ is NUL-separated. A literal includes
          // check still works because the needle never contains NUL.
          if (env.includes(needle)) pids.push(pid);
        } catch {
          // pid disappeared, or no permission - skip
        }
      }
      return pids;
    } catch {
      /* fall through to ps fallback */
    }
  }

  try {
    // macOS / fallback. -E includes env on each process.
    const output = execFileSync("ps", ["-Eo", "pid=,command="], { encoding: "utf-8" });
    for (const line of output.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      if (!m[2].includes(needle)) continue;
      pids.push(parseInt(m[1], 10));
    }
  } catch {
    /* ps absent or refused - return what we have (possibly empty) */
  }
  return pids;
}

/**
 * Return the pids of processes listening on `port` on the loopback
 * interface. Tries `ss` first (Linux), then `lsof` (macOS / Linux).
 * Empty array on any error.
 */
export function findPidsByListenPort(port: number): number[] {
  const pids = new Set<number>();

  try {
    const output = execFileSync("ss", ["-tlnpH"], { encoding: "utf-8" });
    for (const line of output.split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      // ss line ends with users:(("name",pid=12345,fd=N))
      const re = /pid=(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        pids.add(parseInt(m[1], 10));
      }
    }
  } catch {
    /* try lsof */
  }

  if (pids.size === 0) {
    try {
      const output = execFileSync(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        { encoding: "utf-8" },
      );
      for (const raw of output.split("\n")) {
        const pid = parseInt(raw.trim(), 10);
        if (Number.isFinite(pid)) pids.add(pid);
      }
    } catch {
      /* nothing available */
    }
  }

  return Array.from(pids);
}

/**
 * Read the parent pid of `pid` from /proc. Returns null when not
 * available (non-Linux, no permission, or pid is gone).
 */
export function getParentPid(pid: number): number | null {
  if (!existsSync(`/proc/${pid}/stat`)) return null;
  try {
    // /proc/<pid>/stat fields are space-separated, but the second
    // field (comm) is wrapped in parens and can contain spaces. Slice
    // off everything up to the closing paren before splitting.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const tail = stat.slice(closeParen + 2);
    const fields = tail.split(" ");
    // After the (comm) field, the next fields are: state ppid pgrp ...
    const ppid = parseInt(fields[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Return pids of running bridge-server.js processes whose
 * AGENTBRIDGE_STATE_DIR env points at `stateDir` AND whose parent
 * process is no longer alive. The parent-dead test is what makes
 * this an "orphan": a still-attached bridge-server has its Claude
 * Code parent alive, and killing it would stomp on a legitimate
 * session.
 */
export function findOrphanBridgeServers(stateDir: string): number[] {
  const candidates = findPidsByEnv("AGENTBRIDGE_STATE_DIR", stateDir);
  const orphans: number[] = [];
  for (const pid of candidates) {
    const ppid = getParentPid(pid);
    // No parent info available -> conservative: leave it alone.
    if (ppid === null) continue;
    // pid 1 (init) inherits orphans on Linux. That IS the orphan
    // signature - the original parent died and init took over.
    if (ppid === 1) {
      orphans.push(pid);
      continue;
    }
    // Parent still alive -> bridge is attached to a live claude
    // session; do NOT kill it.
    if (isPidAlive(ppid)) continue;
    orphans.push(pid);
  }
  return orphans;
}

/**
 * Best-effort, no-throw kill of a pid. Returns true if the kill
 * call succeeded (or the process was already gone), false on error.
 */
export function tryKill(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SIGTERM, wait up to `gracefulTimeoutMs`, then SIGKILL if the
 * process is still alive. Used for both the daemon and orphan
 * bridge-server reaping. Returns true if we believe the process is
 * gone by the time we return.
 */
export async function gracefulKill(pid: number, gracefulTimeoutMs = 3000): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  tryKill(pid, "SIGTERM");
  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  tryKill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  return !isPidAlive(pid);
}

/** True iff signal-0 succeeds against `pid`. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate all state directories under the default platform state
 * root, one entry per known project (plus the legacy single-instance
 * directory if present). Used by `abg projects` and
 * `abg kill --all`.
 */
export function enumerateStateDirs(stateRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(stateRoot)) return out;
  let entries: string[];
  try {
    entries = readdirSync(stateRoot);
  } catch {
    return out;
  }

  // If the root itself looks like a state dir (has agentbridge.log
  // or daemon.pid right at the top level), include it as the legacy
  // single-instance entry.
  if (looksLikeStateDir(stateRoot)) out.push(stateRoot);

  for (const name of entries) {
    const child = join(stateRoot, name);
    if (looksLikeStateDir(child)) out.push(child);
  }
  return out;
}

function looksLikeStateDir(path: string): boolean {
  return (
    existsSync(join(path, "daemon.pid"))
    || existsSync(join(path, "agentbridge.log"))
    || existsSync(join(path, "status.line"))
  );
}

/** True if we're on a supported Unix-flavored platform. */
export function isSupportedPlatform(): boolean {
  const p = platform();
  return p === "linux" || p === "darwin";
}
