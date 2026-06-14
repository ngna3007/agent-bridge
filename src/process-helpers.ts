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
 * `<envKey>=<envValue>` as an EXACT entry. Empty array on any error.
 *
 * The match is on a full NUL-delimited env entry, NOT a substring of
 * the raw env blob - the previous substring implementation could
 * match e.g. `OLD_AGENTBRIDGE_STATE_DIR=/x` when we asked for
 * `AGENTBRIDGE_STATE_DIR=/x`.
 *
 * Linux path: walks /proc/<pid>/environ (NUL-separated env). Fast
 * (no fork) and works without ps. macOS path: `ps -Eo pid,command`,
 * which prepends the env to the command line as space-separated
 * tokens.
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
          // /proc/<pid>/environ is a NUL-delimited list of
          // KEY=VALUE entries; split on \0 and compare each entry
          // exactly so a suffixed env key cannot false-match.
          if (env.split("\0").includes(needle)) pids.push(pid);
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
    const output = execFileSync("ps", ["-Eww", "-o", "pid=,command="], { encoding: "utf-8" });
    for (const line of output.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      if (!psLineEnvMatches(m[2], needle)) continue;
      pids.push(parseInt(m[1], 10));
    }
  } catch {
    /* ps absent or refused - return what we have (possibly empty) */
  }
  return pids;
}

/**
 * True iff the `ps -E` output fragment `rest` contains the env entry
 * `needle` (`KEY=VALUE`) as a whole entry. Exposed for tests.
 *
 * We CANNOT split on whitespace and call .includes(): env VALUEs can
 * contain spaces. The default macOS state dir is
 * `~/Library/Application Support/AgentBridge`, so a naive token split
 * breaks `AGENTBRIDGE_STATE_DIR=/Users/me/Library/Application Support/AgentBridge/abc`
 * into three pieces and the exact-match needle is never found.
 *
 * Instead, regex-search the raw fragment for the needle anchored on
 * both sides: must follow a space or start, must be followed by a
 * space or end. Values can have spaces in the middle without breaking
 * the match - only the boundary characters matter, and env values
 * can't end with a space because the next env entry would be
 * immediately adjacent.
 */
export function psLineEnvMatches(rest: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`);
  return re.test(rest);
}

/**
 * Read the command line of `pid` as a single string. Returns null
 * when not available. Linux uses /proc/<pid>/cmdline; macOS falls
 * back to `ps -p`.
 */
export function getCommandLine(pid: number): string | null {
  if (existsSync(`/proc/${pid}/cmdline`)) {
    try {
      // cmdline is NUL-separated; collapse to space for matching.
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0+/g, " ").trim();
    } catch {
      return null;
    }
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
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
 * Read the parent pid of `pid`. Linux uses /proc/<pid>/stat; macOS
 * shells out to `ps -p <pid> -o ppid=`. Returns null when not
 * available (pid is gone, ps absent, or permission denied).
 */
export function getParentPid(pid: number): number | null {
  if (existsSync(`/proc/${pid}/stat`)) {
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
  // macOS / no-/proc fallback. `ps -p` is the standard way to read a
  // single process's metadata without scanning all of /proc-equivalent.
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf-8" }).trim();
    const ppid = parseInt(out, 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Pure orphan-classification predicate. Extracted so the rules can be
 * exercised by unit tests without faking out a whole process snapshot.
 *
 * A process is the orphaned MCP frontend iff ALL of:
 *   - envMatch: AGENTBRIDGE_STATE_DIR env equals our state dir
 *   - cmd contains "bridge-server" (so it really is the frontend)
 *   - cmd does NOT contain "daemon.js" (the daemon shares the env)
 *   - cmd does NOT contain "codex" (codex children inherit too)
 *   - ppid is known
 *   - ppid is 1 (reparented to init), OR the parent is not alive
 *
 * Any missing input collapses to "not an orphan, don't touch it" -
 * the orphan reaper is the dangerous half of `abg kill`, so we err
 * on the side of leaving processes alone when uncertain.
 */
export interface OrphanInputs {
  envMatch: boolean;
  cmd: string;
  ppid: number | null;
  parentAlive: boolean;
}
export function isOrphanBridgeServer(i: OrphanInputs): boolean {
  if (!i.envMatch) return false;
  if (!i.cmd.includes("bridge-server")) return false;
  if (i.cmd.includes("daemon.js")) return false;
  if (i.cmd.includes("codex")) return false;
  if (i.ppid === null) return false;
  if (i.ppid === 1) return true;
  return !i.parentAlive;
}

/**
 * Return pids of running bridge-server.js processes that pass
 * `isOrphanBridgeServer`. See that predicate's doc for the rules.
 */
export function findOrphanBridgeServers(stateDir: string): number[] {
  const candidates = findPidsByEnv("AGENTBRIDGE_STATE_DIR", stateDir);
  const orphans: number[] = [];
  for (const pid of candidates) {
    const ppid = getParentPid(pid);
    const inputs: OrphanInputs = {
      envMatch: true, // findPidsByEnv guaranteed it
      cmd: getCommandLine(pid) ?? "",
      ppid,
      parentAlive: ppid !== null && ppid !== 1 ? isPidAlive(ppid) : false,
    };
    if (isOrphanBridgeServer(inputs)) orphans.push(pid);
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
