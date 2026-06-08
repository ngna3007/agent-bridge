/**
 * Per-user preferences for AgentBridge.
 *
 * Distinct from `.agentbridge/config.json` (which is per-project,
 * committed to repos). User prefs are machine-local choices, like
 * "has the user seen the AgentBridge welcome screen yet". They live
 * alongside the daemon runtime state under
 * `$XDG_STATE_HOME/agentbridge/` (or the macOS equivalent).
 *
 * The file format is forward-compatible: unknown keys are preserved
 * on write so a newer agentbridge build doesn't clobber prefs
 * written by an older one (and vice-versa). Older fields that this
 * build no longer needs (cavemanOptIn, rtkOptIn, statusLineAsked,
 * etc.) are left untouched on disk if they exist.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateDirResolver } from "./state-dir";

export interface UserPrefs {
  /**
   * Whether the user has already seen and dismissed the first-run
   * intro screen. Once true we skip the screen for every subsequent
   * `abg claude` invocation.
   */
  introAcknowledged?: boolean;
}

const PREFS_FILE = "user-prefs.json";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class UserPrefsService {
  private readonly path: string;

  constructor(stateDir?: StateDirResolver) {
    const dir = (stateDir ?? new StateDirResolver()).dir;
    this.path = join(dir, PREFS_FILE);
  }

  /** Absolute path to the prefs file. Visible for tests + diagnostics. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Read prefs from disk. Returns an empty object on any I/O or
   * parse error - callers should treat missing keys as defaults.
   */
  load(): UserPrefs {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) return {};
      return this.normalize(parsed);
    } catch {
      return {};
    }
  }

  /**
   * Merge a partial update into existing prefs and persist. Preserves
   * unknown keys (including legacy fields from older builds) so
   * future / past fields survive a write from this version.
   */
  update(patch: Partial<UserPrefs>): void {
    const existing = this.loadRaw();
    const merged = { ...existing, ...patch };
    this.ensureDir();
    writeFileSync(this.path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  }

  /** True when the user has dismissed the first-run intro screen. */
  hasAcknowledgedIntro(): boolean {
    return this.load().introAcknowledged === true;
  }

  /** Read the raw object (preserves unknown keys for merge). */
  private loadRaw(): Record<string, unknown> {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private normalize(raw: Record<string, unknown>): UserPrefs {
    const out: UserPrefs = {};
    if (raw.introAcknowledged === true) out.introAcknowledged = true;
    return out;
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
