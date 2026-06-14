import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus } from "../cli/status";
import { runDoctor } from "../cli/doctor";
import { resolveRuntimeNamespace } from "../runtime-namespace";
import { computeProjectId } from "../project-id";

let tmp: string;
let projectRoot: string;
let stateRoot: string;
let projectStateDir: string;
let savedCwd: () => string;
let savedEnv: Record<string, string | undefined>;
let savedLog: typeof console.log;
let logBuf: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-rt-ns-"));
  projectRoot = join(tmp, "project");
  stateRoot = join(tmp, "state-root");
  mkdirSync(projectRoot);
  mkdirSync(join(projectRoot, ".agentbridge"));
  mkdirSync(stateRoot);

  const projectId = computeProjectId(projectRoot);
  projectStateDir = join(stateRoot, projectId);
  mkdirSync(projectStateDir);

  // Critically: do NOT set AGENTBRIDGE_STATE_DIR here. The whole
  // point of this regression is that the diagnostics commands have
  // to compute it themselves from the project marker.
  savedEnv = {
    AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
    AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
    CODEX_WS_PORT: process.env.CODEX_WS_PORT,
    CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  // Force the platform-default state root to point at our tmp via
  // XDG_STATE_HOME, so resolveRuntimeNamespace ends up at
  // `<tmp>/state-root/agentbridge/<projectId>` once we add the
  // expected agentbridge subdir.
  process.env.XDG_STATE_HOME = tmp;
  process.env.HOME = tmp;

  // Mirror the platform default: $XDG_STATE_HOME/agentbridge.
  const platformRoot = join(tmp, "agentbridge");
  mkdirSync(platformRoot);
  const platformProjectDir = join(platformRoot, projectId);
  mkdirSync(platformProjectDir);
  writeFileSync(join(platformProjectDir, "daemon.pid"), String(process.pid));
  // Also seed status.line + status.json so the diagnostics have
  // something to show.
  writeFileSync(join(platformProjectDir, "status.line"), "[CODEX READY]\n");
  projectStateDir = platformProjectDir;

  savedCwd = process.cwd;
  process.cwd = () => projectRoot;

  savedLog = console.log;
  logBuf = [];
  console.log = (msg?: any) => {
    logBuf.push(typeof msg === "string" ? msg : String(msg));
  };
});

afterEach(() => {
  console.log = savedLog;
  process.cwd = savedCwd;
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveRuntimeNamespace - project mode", () => {
  test("returns the project subdir as the stateDir, not the platform root", () => {
    const ns = resolveRuntimeNamespace({ mutateEnv: false });
    expect(ns.project).not.toBeNull();
    expect(ns.stateDir.dir).toBe(projectStateDir);
  });

  test("returns the project-derived control port", () => {
    const ns = resolveRuntimeNamespace({ mutateEnv: false });
    expect(ns.project).not.toBeNull();
    expect(ns.controlPort).toBe(ns.project!.ports.control);
  });

  test("explicit AGENTBRIDGE_STATE_DIR still wins over project derivation", () => {
    process.env.AGENTBRIDGE_STATE_DIR = "/custom/state";
    const ns = resolveRuntimeNamespace({ mutateEnv: false });
    expect(ns.stateDir.dir).toBe("/custom/state");
  });
});

describe("abg status - project mode regression", () => {
  test("reads the project state dir, not the legacy root", async () => {
    await runStatus();
    const out = logBuf.join("\n");
    // Must observe the seeded pid + status.line in the project dir.
    expect(out).toContain(`running (pid ${process.pid})`);
    expect(out).toContain("[CODEX READY]");
    expect(out).toContain(projectStateDir);
  });
});

describe("abg doctor - project mode regression", () => {
  test("reads the project state dir, not the legacy root", async () => {
    await runDoctor();
    const out = logBuf.join("\n");
    expect(out).toContain(`Daemon running (pid ${process.pid})`);
    expect(out).toContain(projectStateDir);
  });
});
