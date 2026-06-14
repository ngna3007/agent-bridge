/**
 * One-stop resolver for the runtime-namespace decisions that vary by
 * command (claude / codex / kill / status / doctor / projects).
 *
 * Two places used to make these decisions independently:
 *
 *   - cli.ts router applies per-project env vars (control port, state
 *     dir, codex ports) before dispatching the runtime commands. That
 *     was intentionally skipped for read-only commands (status,
 *     doctor) so they could observe the original env, but it left
 *     them resolving the WRONG state dir in project mode - they read
 *     the platform default while the daemon was actually running
 *     under <root>/<projectId>/.
 *
 *   - status.ts and doctor.ts each constructed `new StateDirResolver()`
 *     directly, again landing on the platform default.
 *
 * `resolveRuntimeNamespace` centralizes the decision. It can either
 * mutate process.env (for commands that go on to spawn the daemon)
 * or stay read-only (for diagnostics), and in both cases returns the
 * project info + the state dir + the port triple the caller should
 * actually use. Diagnostics now see the same view the runtime would.
 */

import { join } from "node:path";
import { StateDirResolver } from "./state-dir";
import { resolveProject, applyProjectEnv, type ProjectInfo } from "./project-id";

export interface RuntimeNamespaceOptions {
  /**
   * When true, set AGENTBRIDGE_* / CODEX_*_PORT env vars from the
   * resolved project (if any) so downstream code that reads env
   * picks them up. Defaults to false; only the spawn-the-daemon
   * commands set this.
   */
  mutateEnv?: boolean;
  /**
   * Override the starting directory for project discovery. Tests
   * use this to point at a tmp project root.
   */
  cwd?: string;
}

export interface RuntimeNamespace {
  /** Resolved project info, or null when running in single-instance mode. */
  project: ProjectInfo | null;
  /**
   * State dir the caller should actually read / write. In project
   * mode this is `<platform-default>/<projectId>/`. Honors an
   * explicit AGENTBRIDGE_STATE_DIR override that was set before we
   * ran (e.g. by the user shell or by an outer test harness).
   */
  stateDir: StateDirResolver;
  /**
   * Control port the caller should bind to / connect to. Honors an
   * AGENTBRIDGE_CONTROL_PORT override; otherwise project-derived
   * when in project mode; otherwise the historical 4502.
   */
  controlPort: number;
}

export function resolveRuntimeNamespace(opts: RuntimeNamespaceOptions = {}): RuntimeNamespace {
  const project = resolveProject(opts.cwd ?? process.cwd());

  // Compute the platform-default root WITHOUT inheriting any
  // pre-existing AGENTBRIDGE_STATE_DIR, then re-instantiate the
  // resolver to take env-driven nesting into account afterwards.
  const prevStateDir = process.env.AGENTBRIDGE_STATE_DIR;
  delete process.env.AGENTBRIDGE_STATE_DIR;
  const baseStateDir = new StateDirResolver().dir;
  if (prevStateDir !== undefined) process.env.AGENTBRIDGE_STATE_DIR = prevStateDir;

  if (opts.mutateEnv && project) {
    // Write the project-derived defaults into env so downstream
    // modules (config-service, daemon-lifecycle, bridge.ts) pick
    // them up via process.env. Explicit user overrides win.
    applyProjectEnv(project, baseStateDir);
  }

  // What state dir does the caller actually need?
  // - Explicit env override (set by user, or applyProjectEnv above): use it.
  // - Else project mode: <baseStateDir>/<projectId>/.
  // - Else single-instance: baseStateDir.
  let stateDirPath: string;
  if (process.env.AGENTBRIDGE_STATE_DIR) {
    stateDirPath = process.env.AGENTBRIDGE_STATE_DIR;
  } else if (project) {
    stateDirPath = join(baseStateDir, project.projectId);
  } else {
    stateDirPath = baseStateDir;
  }
  const stateDir = new StateDirResolver(stateDirPath);

  // Control port follows the same precedence rules.
  let controlPort: number;
  const envCtrl = process.env.AGENTBRIDGE_CONTROL_PORT;
  if (envCtrl) {
    controlPort = parseInt(envCtrl, 10);
  } else if (project) {
    controlPort = project.ports.control;
  } else {
    controlPort = 4502;
  }

  return { project, stateDir, controlPort };
}
