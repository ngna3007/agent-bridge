/**
 * Safe edits to ~/.claude/settings.json.
 *
 * AgentBridge offers to wire one small thing into the user's Claude
 * Code settings during onboarding: a `statusLine.command` that
 * displays our status file in Claude Code's statusbar. Editing a
 * config file the user owns is sensitive, so this module follows a
 * few rules:
 *
 *   1. Never silently overwrite an unrelated existing command.
 *      When `statusLine.command` already runs something else
 *      (caveman, the user's own script, etc.) we *chain* our cat
 *      onto the existing command rather than replace it. The chained
 *      command keeps the user's old behavior and appends our short
 *      tag on the same statusbar line.
 *   2. Always back up the previous file first (copy to
 *      settings.json.bak.<timestamp>). The user can roll back.
 *   3. Preserve every other key, including any we don't know about.
 *      We read -> patch -> write, never replace.
 *   4. Be JSON-aware (not text-substitution). Read with JSON.parse,
 *      write with JSON.stringify(_, _, 2). If the existing file is
 *      malformed, refuse to edit (the user has a worse problem).
 *   5. Be idempotent: a second run on a chained command notices our
 *      `cat <statusFilePath>` substring is already present and does
 *      nothing.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface WireStatusLineOptions {
  /** Absolute path to the status file. */
  statusFilePath: string;
  /** Override settings.json path (for tests). */
  settingsPath?: string;
  /**
   * If true, replace an existing `statusLine.command` outright rather
   * than chaining. Default false: we chain onto whatever's there so
   * the user's existing statusbar tools (caveman, etc.) keep working
   * and our tag gets appended.
   */
  force?: boolean;
}

export type WireStatusLineResult =
  | {
    /** Wrote a fresh statusLine command (no prior command existed). */
    status: "wired";
    backupPath: string | null;
    command: string;
  }
  | {
    /** Existing command already invokes our cat; no change made. */
    status: "already-correct";
    command: string;
  }
  | {
    /**
     * Chained our cat onto a pre-existing command. The old command
     * still runs first; our tag is appended to its output on the
     * same statusbar line.
     */
    status: "chained";
    backupPath: string | null;
    previousCommand: string;
    command: string;
  }
  | {
    status: "error";
    reason: string;
  };

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const GATE_MARKER = '"$AGENTBRIDGE_ACTIVE" = "1"';

/**
 * Build a shell command that prints AgentBridge's status tag only
 * when this Claude session was launched via `abg claude`. That
 * sessions sets AGENTBRIDGE_ACTIVE=1 in its environment, which
 * propagates to the statusLine command's subshell. Plain `claude` /
 * `claude -c` sessions (which don't set the flag) get a silent
 * pass-through so the user doesn't see stale bridge state.
 */
function gatedCat(statusFilePath: string): string {
  return `[ ${GATE_MARKER} ] && cat ${statusFilePath}`;
}

/**
 * Build a one-line shell command that runs `existing` first, then
 * conditionally appends a space and the contents of `statusFilePath`
 * (only when AGENTBRIDGE_ACTIVE=1). The whole thing is piped through
 * `tr -d '\n'` so embedded newlines from either source don't push
 * the statusbar to a second line.
 */
function composeChainedCommand(existing: string, statusFilePath: string): string {
  return `{ ${existing}; [ ${GATE_MARKER} ] && { printf ' '; cat ${statusFilePath}; }; } | tr -d '\\n'`;
}

/**
 * True when the command is already in the current gated format
 * (contains both our cat AND the env gate). We treat anything else
 * containing `cat <path>` as an upgrade candidate.
 */
function alreadyChained(command: string, statusFilePath: string): boolean {
  return command.includes(`cat ${statusFilePath}`) && command.includes(GATE_MARKER);
}

/**
 * Detect AgentBridge's previous (ungated) chained format and return
 * the user's original pre-AgentBridge command (e.g. the caveman
 * statusLine script). Returns null when the command isn't our old
 * chain shape.
 *
 * Old format (no env gate):
 *   { <original>; printf ' '; cat <path>; } | tr -d '\n'
 */
function tryParseOldChain(command: string, statusFilePath: string): string | null {
  const prefix = "{ ";
  const tail = `; printf ' '; cat ${statusFilePath}; } | tr -d '\\n'`;
  if (!command.startsWith(prefix) || !command.endsWith(tail)) return null;
  return command.slice(prefix.length, command.length - tail.length);
}

/**
 * Configure the Claude Code statusLine command to display the
 * AgentBridge status file. Returns a structured result the caller
 * can render to the user.
 */
export function wireStatusLine(opts: WireStatusLineOptions): WireStatusLineResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const standaloneCommand = gatedCat(opts.statusFilePath);

  // Load current settings (or start from {} if the file doesn't exist).
  let raw: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    let text: string;
    try {
      text = readFileSync(settingsPath, "utf-8");
    } catch (e: any) {
      return { status: "error", reason: `cannot read ${settingsPath}: ${e.message}` };
    }
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text);
        if (!isRecord(parsed)) {
          return {
            status: "error",
            reason: `${settingsPath} is valid JSON but not an object; refusing to edit`,
          };
        }
        raw = parsed;
      } catch (e: any) {
        return {
          status: "error",
          reason: `${settingsPath} is not valid JSON: ${e.message}. Fix the file by hand first.`,
        };
      }
    }
  }

  // Inspect any existing statusLine command.
  const existing = raw.statusLine;
  let newCommand: string = standaloneCommand;
  let chainedFrom: string | null = null;

  if (isRecord(existing) && typeof existing.command === "string") {
    const existingCommand = existing.command;
    if (alreadyChained(existingCommand, opts.statusFilePath)) {
      return { status: "already-correct", command: existingCommand };
    }
    if (opts.force) {
      newCommand = standaloneCommand;
    } else {
      // Migration: detect AgentBridge's previous ungated chain and
      // rebuild from the original prefix so we don't nest a chain
      // inside another chain (which would double-print our cat).
      const oldChainOriginal = tryParseOldChain(existingCommand, opts.statusFilePath);
      if (oldChainOriginal !== null) {
        newCommand = composeChainedCommand(oldChainOriginal, opts.statusFilePath);
        chainedFrom = oldChainOriginal;
      } else if (existingCommand === `cat ${opts.statusFilePath}`) {
        // Old ungated standalone -> upgrade to gated standalone.
        newCommand = standaloneCommand;
      } else {
        // Unknown command (user hand-edit or third-party) -> chain
        // onto it. We trust the user's existing tooling and only
        // append our gated cat after it.
        newCommand = composeChainedCommand(existingCommand, opts.statusFilePath);
        chainedFrom = existingCommand;
      }
    }
  }

  // Backup the existing file (if any), then write the patched copy.
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      const st = statSync(settingsPath);
      // Use mtime as the backup suffix so repeated re-wires of the
      // same file don't all collide on one timestamp.
      backupPath = `${settingsPath}.bak.${Math.floor(st.mtimeMs)}`;
      copyFileSync(settingsPath, backupPath);
    } catch (e: any) {
      return { status: "error", reason: `cannot back up ${settingsPath}: ${e.message}` };
    }
  } else {
    // Make sure ~/.claude exists.
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
    } catch (e: any) {
      return { status: "error", reason: `cannot create ${dirname(settingsPath)}: ${e.message}` };
    }
  }

  // Merge our statusLine into whatever existed (preserving siblings).
  const existingStatusLine = isRecord(existing) ? existing : {};
  const patched = {
    ...raw,
    statusLine: { ...existingStatusLine, command: newCommand },
  };

  try {
    writeFileSync(settingsPath, JSON.stringify(patched, null, 2) + "\n", "utf-8");
  } catch (e: any) {
    return { status: "error", reason: `cannot write ${settingsPath}: ${e.message}` };
  }

  if (chainedFrom !== null) {
    return { status: "chained", backupPath, previousCommand: chainedFrom, command: newCommand };
  }
  return { status: "wired", backupPath, command: newCommand };
}
