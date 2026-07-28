/**
 * Per-project namespacing so multiple AgentBridge sessions can run
 * side by side on the same machine.
 *
 * The default single-instance model uses fixed ports (4500-4502) and
 * a single platform state dir, which forces "one Claude slot per
 * machine". When the user has run `abg init` in a project (i.e. the
 * `.agentbridge/` marker directory exists somewhere in the cwd's
 * ancestors), we treat that project as a distinct AgentBridge
 * "namespace":
 *
 *   - The project ID is the first 8 hex chars of the SHA-256 of the
 *     project's absolute root path. Deterministic, stable, collision-
 *     resistant for any realistic number of projects on one machine.
 *
 *   - The project's ports are derived from the project ID: we map
 *     the hex prefix into a 1000-slot grid starting at 14500, with
 *     3 sequential ports per slot. Each project gets its own
 *     (codexWs, codexProxy, control) triple. 1000 slots is enough
 *     for any plausible per-user setup, and the 14500-17499 range is
 *     well clear of system / app server ports.
 *
 *   - The project's state dir nests under the platform default:
 *     `<platform-default>/<projectId>/`. So a project's daemon pid,
 *     log, status.line, audit.jsonl, etc. live under their own
 *     subdirectory.
 *
 * When no `.agentbridge/` marker is found, this module returns null
 * and the CLI falls back to the historical single-instance behavior
 * (defaults at 4500/4501/4502, state at the platform default). That
 * preserves backward compatibility for users who never opted in via
 * `abg init`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Directory name we treat as the project-root marker. */
const PROJECT_MARKER = ".agentbridge";

/**
 * Lowest port in the per-project pool. Picked so the entire range
 * (14500-17499 with the default slot count) sits in unassigned IANA
 * space and away from typical app-server ports.
 */
const BASE_PORT = 14500;
/** Number of distinct port slots = max projects without collision. */
const PORT_SLOT_COUNT = 1000;
/** Ports allocated per project: codexWs + codexProxy + control. */
const PORTS_PER_PROJECT = 3;

export interface ProjectPorts {
  codexWs: number;
  codexProxy: number;
  control: number;
}

export interface ProjectInfo {
  /** Absolute path to the directory containing the `.agentbridge/` marker. */
  rootPath: string;
  /** 8-hex-character project identifier derived from the root path. */
  projectId: string;
  /** Per-project port allocation. */
  ports: ProjectPorts;
}

/**
 * Walk from `startDir` upward, returning the first ancestor that
 * contains a `.agentbridge/` directory. Returns null if none exists
 * up to the filesystem root.
 */
export function findProjectRoot(startDir: string): string | null {
  let cur = resolve(startDir);
  while (true) {
    if (existsSync(join(cur, PROJECT_MARKER))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Reasons a directory may not become an AgentBridge project root.
 * Returned rather than thrown so callers can choose their register:
 * `abg init` errors loudly, the first-run offer just stays quiet.
 */
export type SetupRefusal =
  | { kind: "unsafe-root"; dir: string }
  | { kind: "nested"; dir: string; existingRoot: string };

/**
 * Decide whether `dir` may hold a `.agentbridge/` marker.
 *
 * Two refusals, both about the marker's blast radius: a marker at $HOME
 * or `/` namespaces every directory beneath it, and a marker nested
 * inside an existing project splits one project's namespace in two.
 */
export function checkSetupLocation(dir: string, home: string): SetupRefusal | null {
  const target = resolve(dir);
  if (target === resolve(home) || target === dirname(resolve(home)) || target === "/") {
    return { kind: "unsafe-root", dir: target };
  }
  const existingAncestor = findProjectRoot(target);
  if (existingAncestor && existingAncestor !== target) {
    return { kind: "nested", dir: target, existingRoot: existingAncestor };
  }
  return null;
}

/** SHA-256 the absolute project path; return first 8 hex chars. */
export function computeProjectId(rootPath: string): string {
  return createHash("sha256").update(resolve(rootPath)).digest("hex").slice(0, 8);
}

/** Map a project ID to its (codexWs, codexProxy, control) port triple. */
export function computeProjectPorts(projectId: string): ProjectPorts {
  const slot = parseInt(projectId, 16) % PORT_SLOT_COUNT;
  const base = BASE_PORT + slot * PORTS_PER_PROJECT;
  return {
    codexWs: base,
    codexProxy: base + 1,
    control: base + 2,
  };
}

/**
 * Which of `candidateIds` land on the same port slot as `selfId`.
 *
 * The slot is `projectId mod 1000`, so distinct projects can share
 * one. It is not rare enough to ignore: by the birthday bound, ten
 * projects on a machine collide about 4% of the time and twenty about
 * 17%. A collision is invisible until both projects run at once, at
 * which point the second one's daemon finds the first one's
 * app-server sitting on its port.
 *
 * Pure so the check is testable without a filesystem; the caller
 * supplies the candidate ids from wherever it knows about projects.
 */
export function findSlotCollisions(selfId: string, candidateIds: string[]): string[] {
  const selfPort = computeProjectPorts(selfId).control;
  return candidateIds.filter(
    (id) => id !== selfId && computeProjectPorts(id).control === selfPort,
  );
}

/**
 * Discover the project (if any) for the given cwd and return its
 * full info object. Returns null when no project marker is found.
 */
export function resolveProject(startDir: string = process.cwd()): ProjectInfo | null {
  const rootPath = findProjectRoot(startDir);
  if (!rootPath) return null;
  const projectId = computeProjectId(rootPath);
  const ports = computeProjectPorts(projectId);
  return { rootPath, projectId, ports };
}

/**
 * Apply a resolved project's namespacing to `process.env` so any
 * downstream code that reads `AGENTBRIDGE_*` / `CODEX_*_PORT`
 * automatically uses the per-project values. Explicit env vars the
 * user already set are NEVER overwritten - they still take
 * precedence over project defaults.
 *
 * Idempotent. Safe to call multiple times.
 */
export function applyProjectEnv(project: ProjectInfo, baseStateDir: string): void {
  if (!process.env.AGENTBRIDGE_CONTROL_PORT) {
    process.env.AGENTBRIDGE_CONTROL_PORT = String(project.ports.control);
  }
  if (!process.env.CODEX_WS_PORT) {
    process.env.CODEX_WS_PORT = String(project.ports.codexWs);
  }
  if (!process.env.CODEX_PROXY_PORT) {
    process.env.CODEX_PROXY_PORT = String(project.ports.codexProxy);
  }
  if (!process.env.AGENTBRIDGE_STATE_DIR) {
    process.env.AGENTBRIDGE_STATE_DIR = join(baseStateDir, project.projectId);
  }
  // PROJECT_ID is informational - lets the daemon stamp its logs
  // with which project they belong to without having to re-derive.
  if (!process.env.AGENTBRIDGE_PROJECT_ID) {
    process.env.AGENTBRIDGE_PROJECT_ID = project.projectId;
  }
}
