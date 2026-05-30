/**
 * Durable, append-only audit log of every BridgeMessage + lifecycle event
 * passing through the daemon. JSONL, one record per line, short keys for
 * compactness. Rotates by size to bound disk growth.
 *
 * Design intent:
 * - The daemon's existing `agentbridge.log` is human-readable diagnostic
 *   prose. This is a structured *machine-replayable* record — every msg
 *   in either direction, every TUI/turn/daemon event. Survives daemon
 *   restarts. Greppable. Queryable via the `transcript` MCP tool.
 * - Append must never block daemon shutdown — fire-and-forget, errors
 *   logged but never thrown to the caller.
 * - Rotation is cheap: when current file > maxBytes, rename to .1 (and
 *   shift .1 → .2 etc.); start a fresh current. Older than maxRotations
 *   are dropped. Default 10MB × 3 rotations = ~30MB ceiling per project.
 *
 * Record schema (always JSONL, one record per line):
 *   { t: <ms epoch>, k: "msg", dir: "in"|"out", from: "claude"|"codex",
 *     to: "claude"|"codex", id: "<msg-id>", content: "<body>" }
 *   { t: <ms epoch>, k: "evt", event: "<name>", meta?: <object> }
 */

import { existsSync, statSync, renameSync, unlinkSync, openSync, closeSync, writeSync, fsyncSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeMessage, MessageSource } from "./types";

export type AuditRecord =
  | { t: number; k: "msg"; from: MessageSource; to: MessageSource; id: string; content: string }
  | { t: number; k: "evt"; event: string; meta?: Record<string, unknown> };

export interface AuditLogOptions {
  /** Max bytes per current file before rotation. Default 10MB. */
  maxBytes?: number;
  /** How many rotated files (.1, .2, ...) to keep. Default 3. */
  maxRotations?: number;
}

export class AuditLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxRotations: number;
  private writing = false;
  private readonly queue: AuditRecord[] = [];

  constructor(path: string, opts: AuditLogOptions = {}) {
    this.path = path;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.maxRotations = opts.maxRotations ?? 3;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // Honor "never throws" — if the parent can't be created (e.g. it's
      // a regular file blocking the path), individual append calls will
      // also fail and log to stderr. Constructing a broken log shouldn't
      // crash the daemon at startup.
    }
  }

  get filePath(): string {
    return this.path;
  }

  /** Append one record. Returns immediately; never throws. */
  append(record: AuditRecord): void {
    this.queue.push(record);
    if (!this.writing) {
      void this.drain();
    }
  }

  appendMessage(msg: BridgeMessage): void {
    // Log one record per delivered message. `from` is the author (msg.source);
    // `to` is the peer the daemon forwards it to (the inverse). Caller is
    // expected to invoke ONCE at the actual delivery point — not at every
    // transit hop — to avoid duplicate records on the same message.
    const to: MessageSource = msg.source === "claude" ? "codex" : "claude";
    this.append({
      t: Date.now(),
      k: "msg",
      from: msg.source,
      to,
      id: msg.id,
      content: msg.content,
    });
  }

  appendEvent(event: string, meta?: Record<string, unknown>): void {
    this.append({
      t: Date.now(),
      k: "evt",
      event,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }

  /**
   * Read recent records from the current file only (oldest rotations are
   * not scanned). Tradeoff: O(file size) scan but no streaming-state to
   * maintain across rotations. Default sufficient for typical sessions.
   * For full-history retrieval, callers should iterate rotations directly.
   */
  queryRecent(opts: { limit?: number; sinceMs?: number; kind?: "msg" | "evt" } = {}): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    const limit = opts.limit ?? 100;
    const sinceMs = opts.sinceMs ?? 0;
    const wantKind = opts.kind;

    const records: AuditRecord[] = [];
    const raw = readFileSync(this.path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      if (parsed.t < sinceMs) continue;
      if (wantKind && parsed.k !== wantKind) continue;
      records.push(parsed);
    }
    // Most-recent-last, then trim from the head if over limit.
    return records.slice(-limit);
  }

  /**
   * Force-flush + rotate immediately. Mainly for tests. Production code
   * doesn't need this — rotation is automatic during normal append flow.
   */
  rotateNow(): void {
    this.rotateIfNeeded(this.maxBytes + 1);
  }

  // ────────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length);
        await this.writeBatch(batch);
      }
    } finally {
      this.writing = false;
    }
  }

  private async writeBatch(batch: AuditRecord[]): Promise<void> {
    // Serialize one record per line. JSON.stringify with default key
    // ordering is fine — the schema is small enough that the key order
    // is deterministic across Node/Bun versions.
    const payload = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";

    // Check current size first; rotate before write if this batch would
    // exceed maxBytes. We rotate based on pre-write size, not post —
    // means the new current can briefly exceed maxBytes by one batch.
    // That's acceptable; the alternative (chunking writes mid-batch) is
    // not worth the complexity.
    const currentSize = this.currentFileSize();
    if (currentSize + payload.length > this.maxBytes && currentSize > 0) {
      this.rotateIfNeeded(currentSize + payload.length);
    }

    // O_APPEND + writeSync + fsyncSync for atomicity (POSIX guarantees
    // append on a single write within PIPE_BUF; our records are small).
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "a", 0o644);
      writeSync(fd, payload);
      fsyncSync(fd);
    } catch (err) {
      // Best-effort: log to stderr but never throw upward. The audit
      // log going down should not bring the daemon down with it.
      process.stderr.write(`[audit-log] write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  private currentFileSize(): number {
    if (!existsSync(this.path)) return 0;
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  private rotateIfNeeded(currentSize: number): void {
    if (currentSize <= this.maxBytes) return;

    // Drop the oldest rotation if present.
    const oldest = `${this.path}.${this.maxRotations}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* ignore */ }
    }

    // Shift .N-1 -> .N, .N-2 -> .N-1, ..., .1 -> .2
    for (let i = this.maxRotations - 1; i >= 1; i--) {
      const src = `${this.path}.${i}`;
      const dst = `${this.path}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    // current → .1
    if (existsSync(this.path)) {
      try { renameSync(this.path, `${this.path}.1`); } catch { /* ignore */ }
    }
  }
}

/**
 * Default audit-log path resolver: drop next to the daemon's log file.
 * Used by daemon.ts so the user has one place to look.
 */
export function defaultAuditLogPath(stateDir: string): string {
  return join(stateDir, "audit.jsonl");
}
