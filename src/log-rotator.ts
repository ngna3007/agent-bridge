/**
 * Size-based rotating logger.
 *
 * Enforces a hard ceiling on the daemon's log file while preserving the
 * existing "never throw from logging" contract.
 *
 * Design:
 *   - Single shared instance per absolute path (singleton cache).
 *   - In-memory byte counter — seeded once via `statSync` at construct
 *     and incremented per write. No statSync on the hot path.
 *   - Rotation: rename chain `log → log.1 → log.2 → ... → drop oldest`.
 *     Uses `renameSync` (atomic on POSIX) so concurrent appends from
 *     other writers either land in the rotated file or the fresh one,
 *     never split mid-line.
 *   - Startup guard: if the existing file is already over the cap, the
 *     constructor rotates it immediately — this catches the case where a
 *     prior daemon ran without rotation (the bug we're fixing).
 *   - All filesystem operations are wrapped in try/catch and silently
 *     degrade. Logging must never crash the daemon.
 *
 * Configuration:
 *   AGENTBRIDGE_LOG_MAX_BYTES (default 50_000_000 = 50 MB)
 *   AGENTBRIDGE_LOG_MAX_FILES (default 3, gives ~200 MB hard ceiling)
 *
 * The defaults are deliberate: 50 MB per file is large enough to capture
 * a full multi-day session of useful diagnostics, small enough that a
 * runaway log can't fill a disk before being noticed.
 */

import { appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";

const DEFAULT_MAX_BYTES = 50_000_000;
const DEFAULT_MAX_FILES = 3;
const MIN_MAX_BYTES = 1024; // 1 KB — any smaller is almost certainly a misconfig
const MIN_MAX_FILES = 1;

function parseEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

export interface RotatingLoggerOptions {
  maxBytes?: number;
  maxFiles?: number;
}

export class RotatingLogger {
  private bytesWritten = 0;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly path: string, opts: RotatingLoggerOptions = {}) {
    // Explicit options are trusted (callers know what they're doing —
    // tests use very small caps deliberately). Env-derived values go
    // through parseEnvInt which enforces sane minimums against typos.
    this.maxBytes = opts.maxBytes ?? parseEnvInt("AGENTBRIDGE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES, MIN_MAX_BYTES);
    this.maxFiles = opts.maxFiles ?? parseEnvInt("AGENTBRIDGE_LOG_MAX_FILES", DEFAULT_MAX_FILES, MIN_MAX_FILES);
    this.seed();
  }

  /**
   * Append a line to the log, rotating first if the file would exceed the cap.
   * Never throws. The caller is responsible for the trailing newline.
   */
  write(line: string): void {
    try {
      const bytes = Buffer.byteLength(line, "utf8");
      if (this.bytesWritten + bytes > this.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.path, line);
      this.bytesWritten += bytes;
    } catch {
      // Silently ignore — logging must not crash the daemon.
    }
  }

  /**
   * Force a rotation now, regardless of current size.
   * Exposed for tests and for callers that need a deterministic boundary.
   */
  rotate(): void {
    try {
      // Drop the oldest generation if it exists.
      const oldest = this.generationPath(this.maxFiles);
      this.silentUnlink(oldest);

      // Shift each remaining generation down by one (highest → lowest first
      // to avoid clobbering): .N-1 → .N, .N-2 → .N-1, ... .1 → .2, log → .1
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        this.silentRename(this.generationPath(i), this.generationPath(i + 1));
      }
      this.silentRename(this.path, this.generationPath(1));

      // After rename, the active path no longer exists — the next append
      // will create a fresh file. Reset the counter.
      this.bytesWritten = 0;
    } catch {
      // Even rotation must not crash logging. If rename fails (e.g. another
      // process raced us) we just keep going — the next write attempt will
      // re-evaluate the size.
    }
  }

  /** Returns the in-memory size counter. Visible for tests + diagnostics. */
  getBytesWritten(): number {
    return this.bytesWritten;
  }

  private seed(): void {
    try {
      const st = statSync(this.path);
      // If the existing log is already oversize on startup, rotate
      // immediately so we start with a clean slate. Safety net for the
      // case where a prior process wrote without rotation.
      if (st.size > this.maxBytes) {
        this.bytesWritten = st.size;
        this.rotate();
      } else {
        this.bytesWritten = st.size;
      }
    } catch {
      // File doesn't exist yet — counter starts at zero, which is correct.
      this.bytesWritten = 0;
    }
  }

  private generationPath(n: number): string {
    return `${this.path}.${n}`;
  }

  private silentRename(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch {
      // ENOENT (source doesn't exist yet) is expected when generations
      // are not yet populated; other errors we swallow to honor never-throw.
    }
  }

  private silentUnlink(p: string): void {
    try {
      unlinkSync(p);
    } catch {
      // ENOENT is expected — nothing to drop.
    }
  }
}

// Module-level singleton cache. Multiple call sites in the same process
// (claude-adapter, codex-adapter, daemon, bridge) all log to the same
// agentbridge.log file — sharing the counter prevents each of them from
// independently overshooting the cap.
const cache = new Map<string, RotatingLogger>();

export function getRotatingLogger(path: string, opts?: RotatingLoggerOptions): RotatingLogger {
  let inst = cache.get(path);
  if (!inst) {
    inst = new RotatingLogger(path, opts);
    cache.set(path, inst);
  }
  return inst;
}

/** Test-only: drop the singleton cache so each test gets a fresh logger. */
export function _resetLoggerCacheForTests(): void {
  cache.clear();
}
