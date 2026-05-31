/**
 * Single-line "current status" file.
 *
 * Writes one line representing the most recent lifecycle event (TUI
 * connected, daemon disconnected, evicted, etc.) so users can wire it
 * into their Claude Code statusLine shell command:
 *
 *   "statusLine": { "command": "cat ~/.local/state/agentbridge/status.line" }
 *
 * The file is overwritten in full on every event - there's no history
 * here, just "what's true right now". A history audit log lives
 * separately (see AuditLog in src/audit-log.ts).
 *
 * The writer never throws. Logging that takes down the daemon would be
 * worse than missing a status update.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateDirResolver } from "./state-dir";

export interface StatusLineSnapshot {
  /** Compact one-line message (no newlines). */
  message: string;
  /** ISO-8601 timestamp at which the event was emitted. */
  timestamp?: string;
}

export class StatusLineWriter {
  private readonly path: string;

  constructor(stateDir?: StateDirResolver) {
    const dir = (stateDir ?? new StateDirResolver()).dir;
    this.path = join(dir, "status.line");
  }

  /** Absolute path to the status.line file. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Overwrite the status file with a single line. Newlines in the
   * message are flattened so users' statusLine commands never see
   * multi-line garbage.
   */
  write(snapshot: StatusLineSnapshot): void {
    try {
      this.ensureDir();
      const ts = snapshot.timestamp ?? new Date().toISOString();
      const oneLine = snapshot.message.replace(/[\r\n]+/g, " ").trim();
      writeFileSync(this.path, `${ts}\t${oneLine}\n`, "utf-8");
    } catch {
      // Silently ignore - status writes must not crash the daemon.
    }
  }

  /** Clear the status (writes an empty file). */
  clear(): void {
    try {
      this.ensureDir();
      writeFileSync(this.path, "", "utf-8");
    } catch {
      /* ignore */
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
