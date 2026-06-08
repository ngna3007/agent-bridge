/**
 * Single-line "current status" file.
 *
 * Holds one compact tag representing the bridge's current state,
 * e.g. "[CODEX]" when Codex is connected or "[OFFLINE]" when the
 * link is down. Users wire it into Claude Code's statusLine command
 * to display it at the bottom edge of the TUI:
 *
 *   "statusLine": { "command": "cat ~/.local/state/agentbridge/status.line" }
 *
 * The file is overwritten in full on every state change - there is
 * no history here, just "what's true right now". A history audit log
 * lives separately (see AuditLog in src/audit-log.ts).
 *
 * The writer never throws. Logging that takes down the daemon would
 * be worse than missing a status update.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateDirResolver } from "./state-dir";

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
   * Overwrite the status file with a single tag. Newlines inside the
   * tag are flattened so users' statusLine commands never see
   * multi-line garbage.
   */
  write(tag: string): void {
    try {
      this.ensureDir();
      const oneLine = tag.replace(/[\r\n]+/g, " ").trim();
      writeFileSync(this.path, `${oneLine}\n`, "utf-8");
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
