import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus } from "../cli/status";

let tmp: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;
let savedLog: typeof console.log;
let savedCwd: () => string;
let logBuf: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-status-"));
  cwd = join(tmp, "project");
  mkdirSync(cwd);

  savedEnv = {
    AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
    AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
    CODEX_WS_PORT: process.env.CODEX_WS_PORT,
    CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  process.env.AGENTBRIDGE_STATE_DIR = join(tmp, "state");
  mkdirSync(process.env.AGENTBRIDGE_STATE_DIR);

  savedCwd = process.cwd;
  process.cwd = () => cwd;

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

describe("runStatus - no project marker", () => {
  test("falls back to single-instance mode banner", async () => {
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("no .agentbridge/ marker");
    expect(out).toContain("Single-instance mode");
    expect(out).toContain("not running");
  });
});

describe("runStatus - project mode", () => {
  test("reports the project id, root, and per-project ports", async () => {
    mkdirSync(join(cwd, ".agentbridge"));
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("Project");
    expect(out).toContain(cwd); // root path
    expect(out).toMatch(/id\s+[0-9a-f]{8}/);
    expect(out).toMatch(/codex port\s+\d+/);
    expect(out).toMatch(/control\s+\d+/);
  });
});

describe("runStatus - daemon state", () => {
  test("reports running when pid file points at this very process", async () => {
    writeFileSync(join(process.env.AGENTBRIDGE_STATE_DIR!, "daemon.pid"), String(process.pid));
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain(`running (pid ${process.pid})`);
  });

  test("reports stale when pid file points at a dead process", async () => {
    writeFileSync(join(process.env.AGENTBRIDGE_STATE_DIR!, "daemon.pid"), "999999");
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("stale pid 999999");
  });

  test("reports stopped when killed sentinel exists", async () => {
    writeFileSync(join(process.env.AGENTBRIDGE_STATE_DIR!, "killed"), "1");
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("stopped (killed sentinel present)");
  });

  test("surfaces the last status.line tag (ANSI codes stripped)", async () => {
    writeFileSync(join(process.env.AGENTBRIDGE_STATE_DIR!, "status.line"), "\x1b[32m[CODEX READY]\x1b[0m\n");
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("last tag    [CODEX READY]");
    expect(out).not.toContain("\x1b[32m");
  });
});

describe("runStatus - env overrides", () => {
  test("lists explicit env overrides", async () => {
    process.env.AGENTBRIDGE_CONTROL_PORT = "9999";
    await runStatus();
    const out = logBuf.join("\n");
    expect(out).toContain("Env overrides");
    expect(out).toContain("AGENTBRIDGE_CONTROL_PORT=9999");
  });

  test("env block omitted when nothing is overridden", async () => {
    // The harness sets AGENTBRIDGE_STATE_DIR in beforeEach so the
    // status command writes into a tmp dir; clear it for this
    // assertion so the env block is empty.
    const savedStateDir = process.env.AGENTBRIDGE_STATE_DIR;
    delete process.env.AGENTBRIDGE_STATE_DIR;
    try {
      await runStatus();
      const out = logBuf.join("\n");
      expect(out).not.toContain("Env overrides");
    } finally {
      if (savedStateDir !== undefined) process.env.AGENTBRIDGE_STATE_DIR = savedStateDir;
    }
  });
});
