/**
 * Safe edits to ~/.claude/settings.json.
 *
 * AgentBridge offers to wire one small thing into the user's Claude
 * Code settings during onboarding: the `statusLine.command` that
 * displays our status file in Claude's statusbar. Editing a config
 * file the user owns is sensitive, so this module is built around
 * four rules:
 *
 *   1. Never overwrite existing keys silently. If the user already
 *      has a `statusLine` configured, return a conflict report and
 *      let the caller decide.
 *   2. Always back up the previous file first (copy to
 *      settings.json.bak.<timestamp>). The user can roll back.
 *   3. Preserve every other key, including any keys we don't know
 *      about. We read -> patch -> write, never replace.
 *   4. Be JSON-aware (not text-substitution). Read with JSON.parse,
 *      write with JSON.stringify(_, _, 2). If the existing file is
 *      malformed, refuse to edit (the user has a worse problem).
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
   * If true, overwrite an existing `statusLine.command` even when it
   * does not point at the AgentBridge status file. Default false: we
   * refuse and ask the caller (usually the CLI) to surface the conflict.
   */
  force?: boolean;
}

export type WireStatusLineResult =
  | {
    status: "wired";
    /** Path to the backup copy we created, if any. */
    backupPath: string | null;
    /** Final value we wrote into settings. */
    command: string;
  }
  | {
    status: "already-correct";
    command: string;
  }
  | {
    status: "conflict";
    /** Existing command currently in settings.json. */
    existingCommand: string;
  }
  | {
    status: "error";
    /** Plain-language explanation suitable for showing to the user. */
    reason: string;
  };

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Configure the Claude Code statusLine command to display the
 * AgentBridge status file. Returns a structured result the caller
 * can render to the user.
 */
export function wireStatusLine(opts: WireStatusLineOptions): WireStatusLineResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const command = `cat ${opts.statusFilePath}`;

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

  // Inspect existing statusLine, if any.
  const existing = raw.statusLine;
  if (isRecord(existing) && typeof existing.command === "string") {
    if (existing.command === command) {
      return { status: "already-correct", command };
    }
    if (!opts.force) {
      return { status: "conflict", existingCommand: existing.command };
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
    statusLine: { ...existingStatusLine, command },
  };

  try {
    writeFileSync(settingsPath, JSON.stringify(patched, null, 2) + "\n", "utf-8");
  } catch (e: any) {
    return { status: "error", reason: `cannot write ${settingsPath}: ${e.message}` };
  }

  return { status: "wired", backupPath, command };
}
