/**
 * Detect external companion tools that AgentBridge recommends but
 * does NOT bundle: `rtk` (Rust Token Killer CLI proxy) and the
 * caveman skill (a Claude Code skill bundle that compresses Claude's
 * responses).
 *
 * Each detector is best-effort and returns a structured status object.
 * Detection is read-only: nothing is installed, modified, or invoked
 * with side effects. The command runner is injectable so unit tests
 * can simulate every "installed / not installed / wrong tool" branch
 * without touching the host system.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolStatus {
  /** True only when the tool is on PATH AND identified as the right tool. */
  installed: boolean;
  /** Absolute path to the binary (set when we found something on PATH). */
  path?: string;
  /** Self-reported version string, when we could read one. */
  version?: string;
  /**
   * Human-readable reason the status is what it is. Useful for
   * surfacing "we found a different rtk" vs "rtk not found at all".
   */
  note?: string;
}

/** Run an external command and return its stdout, or null on any error. */
export type CommandRunner = (cmd: string, args: string[]) => string | null;

const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

export interface ToolDetectorOptions {
  runCommand?: CommandRunner;
  /** Override $HOME for tests. */
  homeDir?: string;
  /** Override existsSync for tests. */
  fileExists?: (path: string) => boolean;
}

/**
 * Detect Rust Token Killer.
 *
 * Two-step check because the binary name "rtk" collides with
 * "reachingforthejack/rtk" (Rust Type Kit). We resolve the PATH entry
 * first, then run `rtk --version` and require the output to start
 * with "rtk " to be confident we have the right tool.
 */
export function detectRtk(opts: ToolDetectorOptions = {}): ToolStatus {
  const run = opts.runCommand ?? defaultRunner;
  const path = run("which", ["rtk"]);
  if (!path) {
    return { installed: false, note: "rtk not on PATH" };
  }
  const version = run(path, ["--version"]);
  if (!version) {
    return {
      installed: false,
      path,
      note: "rtk on PATH but --version failed (possibly broken install)",
    };
  }
  if (!/^rtk\s+\d/.test(version)) {
    return {
      installed: false,
      path,
      version,
      note: "wrong rtk on PATH (likely reachingforthejack/rtk Rust Type Kit)",
    };
  }
  return { installed: true, path, version };
}

/**
 * Detect the caveman skill bundle.
 *
 * Caveman is a Claude Code skill. We look for the skill descriptor in
 * the standard plugin/skills locations under $HOME. This catches the
 * common case where the user installed it via `claude` plugin/marketplace
 * mechanisms. It does NOT prove the skill is enabled in the user's
 * settings (that requires reading ~/.claude/settings.json and checking
 * the skills allowlist, which is out of scope here).
 */
export function detectCaveman(opts: ToolDetectorOptions = {}): ToolStatus {
  const home = opts.homeDir ?? homedir();
  const exists = opts.fileExists ?? existsSync;

  const candidates = [
    join(home, ".claude", "skills", "caveman"),
    join(home, ".claude", "plugins", "caveman"),
  ];
  for (const dir of candidates) {
    if (exists(dir)) {
      return { installed: true, path: dir };
    }
  }
  // Also probe Claude's plugin cache layout used by some installs.
  const cacheRoot = join(home, ".claude", "plugins", "cache");
  if (exists(cacheRoot)) {
    const cavemanCache = join(cacheRoot, "caveman-marketplace");
    if (exists(cavemanCache)) {
      return { installed: true, path: cavemanCache };
    }
  }
  return { installed: false, note: "caveman skill bundle not found under ~/.claude" };
}
