import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "../cli/doctor";
import { computeProjectId } from "../project-id";

/**
 * `abg doctor --fix` deletes files and signals processes. The line it
 * must not cross is repairing state it only *inferred* was bad, so
 * these tests pin both halves: the repairs it performs, and the ones it
 * declines when the evidence has gone stale between diagnosis and
 * repair.
 */

let tmp: string;
let projectRoot: string;
let stateDir: string;
let savedCwd: () => string;
let savedEnv: Record<string, string | undefined>;
let savedLog: typeof console.log;
let logBuf: string[];

/** A pid that is almost certainly not in use. */
const DEAD_PID = 2_147_483_600;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-doctor-fix-"));
  projectRoot = join(tmp, "project");
  mkdirSync(projectRoot);
  mkdirSync(join(projectRoot, ".agentbridge"));

  savedEnv = {
    AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
    AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
    CODEX_WS_PORT: process.env.CODEX_WS_PORT,
    CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
    AGENTBRIDGE_PIN_CONTRACT: process.env.AGENTBRIDGE_PIN_CONTRACT,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  process.env.XDG_STATE_HOME = tmp;
  process.env.HOME = tmp;

  const platformRoot = join(tmp, "agentbridge");
  mkdirSync(platformRoot);
  stateDir = join(platformRoot, computeProjectId(projectRoot));
  mkdirSync(stateDir);

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

const output = () => logBuf.join("\n");

/** Backdate a file so the doctor's staleness threshold is crossed. */
function ageFile(path: string, seconds: number): void {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(path, when, when);
}

describe("abg doctor (read-only)", () => {
  test("never modifies state without --fix", async () => {
    const pidPath = join(stateDir, "daemon.pid");
    const lockPath = join(stateDir, "startup.lock");
    writeFileSync(pidPath, `${DEAD_PID}\n`);
    writeFileSync(lockPath, "");
    ageFile(lockPath, 120);

    await runDoctor();

    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("advertises which findings --fix can repair", async () => {
    writeFileSync(join(stateDir, "daemon.pid"), `${DEAD_PID}\n`);

    await runDoctor();

    expect(output()).toContain("`abg doctor --fix` can repair this automatically.");
    expect(output()).toMatch(/can be repaired with `abg doctor --fix`/);
  });

  test("says nothing about --fix when no finding is repairable", async () => {
    // The legacy pin-contract warning is advice, not a repair: unsetting
    // an env var for the user would not survive this process anyway.
    process.env.AGENTBRIDGE_PIN_CONTRACT = "always";

    await runDoctor();

    expect(output()).toContain("AGENTBRIDGE_PIN_CONTRACT=always");
    expect(output()).not.toContain("can be repaired with");
  });
});

describe("abg doctor --fix", () => {
  test("removes a stale daemon.pid", async () => {
    const pidPath = join(stateDir, "daemon.pid");
    writeFileSync(pidPath, `${DEAD_PID}\n`);

    await runDoctor(["--fix"]);

    expect(existsSync(pidPath)).toBe(false);
    expect(output()).toContain("removed stale daemon.pid");
  });

  test("leaves a live daemon.pid alone", async () => {
    // Deleting a running daemon's pid file strands it: nothing would
    // ever find it again to stop it.
    const pidPath = join(stateDir, "daemon.pid");
    writeFileSync(pidPath, `${process.pid}\n`);

    await runDoctor(["--fix"]);

    expect(existsSync(pidPath)).toBe(true);
    expect(output()).toContain(`Daemon running (pid ${process.pid})`);
  });

  test("removes a stale startup.lock", async () => {
    const lockPath = join(stateDir, "startup.lock");
    writeFileSync(lockPath, "");
    ageFile(lockPath, 120);

    await runDoctor(["--fix"]);

    expect(existsSync(lockPath)).toBe(false);
    expect(output()).toContain("removed stale startup.lock");
  });

  test("leaves a fresh startup.lock alone", async () => {
    // A young lock means a launch is probably in flight; removing it
    // reopens the double-start race the lock exists to close.
    const lockPath = join(stateDir, "startup.lock");
    writeFileSync(lockPath, "");

    await runDoctor(["--fix"]);

    expect(existsSync(lockPath)).toBe(true);
    expect(output()).toContain("daemon may be starting");
  });

  test("rewrites drifted config ports while preserving unrelated settings", async () => {
    const configPath = join(projectRoot, ".agentbridge", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "1.0",
        codex: { appPort: 4500, proxyPort: 4501 },
        turnCoordination: { attentionWindowSeconds: 99 },
        idleShutdownSeconds: 777,
      }),
    );

    await runDoctor(["--fix"]);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.codex.appPort).not.toBe(4500);
    expect(written.codex.proxyPort).toBe(written.codex.appPort + 1);
    // The drift is in two fields; everything the user tuned survives.
    expect(written.turnCoordination.attentionWindowSeconds).toBe(99);
    expect(written.idleShutdownSeconds).toBe(777);
    expect(output()).toContain("rewrote codex ports");
  });

  test("a second run finds nothing left to repair", async () => {
    writeFileSync(join(stateDir, "daemon.pid"), `${DEAD_PID}\n`);
    await runDoctor(["--fix"]);

    logBuf = [];
    await runDoctor(["--fix"]);

    expect(output()).not.toContain("removed stale daemon.pid");
    expect(output()).toContain("No daemon.pid file");
  });

  test("reports the repair tally", async () => {
    writeFileSync(join(stateDir, "daemon.pid"), `${DEAD_PID}\n`);

    await runDoctor(["--fix"]);

    expect(output()).toContain("AgentBridge doctor --fix");
    expect(output()).toMatch(/1 repaired, 0 skipped/);
  });

  test("says so when a run finds warnings but none are auto-repairable", async () => {
    process.env.AGENTBRIDGE_PIN_CONTRACT = "always";

    await runDoctor(["--fix"]);

    expect(output()).toContain("Nothing here is safely auto-repairable");
  });

  test("repairs every independent finding in one pass", async () => {
    const pidPath = join(stateDir, "daemon.pid");
    const lockPath = join(stateDir, "startup.lock");
    writeFileSync(pidPath, `${DEAD_PID}\n`);
    writeFileSync(lockPath, "");
    ageFile(lockPath, 120);

    await runDoctor(["--fix"]);

    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(output()).toMatch(/2 repaired, 0 skipped/);
  });
});
