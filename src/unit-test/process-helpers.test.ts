import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPidAlive,
  enumerateStateDirs,
  tryKill,
  isOrphanBridgeServer,
  psLineEnvMatches,
} from "../process-helpers";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-proc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isPidAlive", () => {
  test("returns true for this process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for an unlikely-alive pid", () => {
    expect(isPidAlive(999_999)).toBe(false);
  });
});

describe("tryKill", () => {
  test("returns false (no throw) for a dead pid", () => {
    expect(tryKill(999_999, 0)).toBe(false);
  });

  test("returns true for signal 0 against our own pid (permission check)", () => {
    expect(tryKill(process.pid, 0)).toBe(true);
  });
});

describe("enumerateStateDirs", () => {
  test("empty root returns []", () => {
    expect(enumerateStateDirs(tmp)).toEqual([]);
  });

  test("includes a subdirectory that looks like a state dir", () => {
    const sub = join(tmp, "ab12cd34");
    mkdirSync(sub);
    writeFileSync(join(sub, "daemon.pid"), "123");
    const dirs = enumerateStateDirs(tmp);
    expect(dirs).toContain(sub);
  });

  test("includes the root itself when it has top-level state files (legacy layout)", () => {
    writeFileSync(join(tmp, "agentbridge.log"), "hello");
    const dirs = enumerateStateDirs(tmp);
    expect(dirs).toContain(tmp);
  });

  test("skips subdirs that have no AgentBridge markers", () => {
    const sub = join(tmp, "unrelated");
    mkdirSync(sub);
    writeFileSync(join(sub, "random.txt"), "x");
    expect(enumerateStateDirs(tmp)).toEqual([]);
  });

  test("returns both root and child when both look like state dirs", () => {
    writeFileSync(join(tmp, "agentbridge.log"), "x");
    const sub = join(tmp, "ab99");
    mkdirSync(sub);
    writeFileSync(join(sub, "daemon.pid"), "1");
    const dirs = enumerateStateDirs(tmp);
    expect(dirs.length).toBe(2);
    expect(dirs).toContain(tmp);
    expect(dirs).toContain(sub);
  });
});

describe("isOrphanBridgeServer predicate", () => {
  const base = {
    envMatch: true,
    cmd: "node /path/to/bridge-server.js",
    ppid: 1,
    parentAlive: false,
  };
  test("ppid==1 + bridge-server cmd + env match -> orphan", () => {
    expect(isOrphanBridgeServer({ ...base, ppid: 1 })).toBe(true);
  });
  test("parent dead + bridge-server cmd + env match -> orphan", () => {
    expect(isOrphanBridgeServer({ ...base, ppid: 4242, parentAlive: false })).toBe(true);
  });
  test("parent alive (attached bridge) -> NOT orphan", () => {
    expect(isOrphanBridgeServer({ ...base, ppid: 4242, parentAlive: true })).toBe(false);
  });
  test("env mismatch -> NOT orphan even if everything else matches", () => {
    expect(isOrphanBridgeServer({ ...base, envMatch: false })).toBe(false);
  });
  test("cmd is daemon.js -> NOT orphan (daemon shares env)", () => {
    expect(isOrphanBridgeServer({
      ...base, cmd: "node /path/to/daemon.js",
    })).toBe(false);
  });
  test("cmd is codex child -> NOT orphan (codex inherits env)", () => {
    expect(isOrphanBridgeServer({
      ...base, cmd: "node /path/to/codex/cli.js",
    })).toBe(false);
  });
  test("cmd lacks bridge-server marker -> NOT orphan", () => {
    expect(isOrphanBridgeServer({ ...base, cmd: "node /path/to/random.js" })).toBe(false);
  });
  test("ppid unknown -> NOT orphan (err on caution)", () => {
    expect(isOrphanBridgeServer({ ...base, ppid: null })).toBe(false);
  });
  test("daemon.js + ppid==1 (reparented daemon) -> NOT orphan", () => {
    expect(isOrphanBridgeServer({
      ...base, cmd: "node /path/to/daemon.js bridge-server", ppid: 1,
    })).toBe(false);
  });
  test("daemon.js substring NOT in cmd, ppid==1 -> orphan (canonical case)", () => {
    expect(isOrphanBridgeServer({
      ...base, cmd: "/path/to/bridge-server.js", ppid: 1, parentAlive: false,
    })).toBe(true);
  });
});

describe("psLineEnvMatches (macOS env-in-ps-line parsing)", () => {
  // The regression Codex flagged: default macOS state dir contains
  // spaces. Naive whitespace token split silently fails to match.
  const macStateDir = "/Users/me/Library/Application Support/AgentBridge/abc12345";
  const needle = `AGENTBRIDGE_STATE_DIR=${macStateDir}`;

  test("matches when needle is mid-line followed by another env entry", () => {
    const rest = `SHELL=/bin/zsh ${needle} PATH=/usr/bin /usr/local/bin/node /path/bridge-server.js`;
    expect(psLineEnvMatches(rest, needle)).toBe(true);
  });
  test("matches when needle is the first env entry", () => {
    const rest = `${needle} HOME=/Users/me /usr/local/bin/node /path/bridge-server.js`;
    expect(psLineEnvMatches(rest, needle)).toBe(true);
  });
  test("matches when needle is followed only by the command (no trailing env)", () => {
    const rest = `${needle} /usr/local/bin/node /path/bridge-server.js`;
    expect(psLineEnvMatches(rest, needle)).toBe(true);
  });
  test("does NOT match a suffixed env key like OLD_AGENTBRIDGE_STATE_DIR=...", () => {
    const rest = `OLD_${needle} PATH=/usr/bin /usr/local/bin/node`;
    expect(psLineEnvMatches(rest, needle)).toBe(false);
  });
  test("does NOT match a different value at the same key", () => {
    const wrong = "AGENTBRIDGE_STATE_DIR=/Users/me/Library/Application Support/AgentBridge/xyz9999";
    const rest = `${wrong} PATH=/usr/bin`;
    expect(psLineEnvMatches(rest, needle)).toBe(false);
  });
  test("regex-escapes special chars in the needle (does not crash on $.()|)", () => {
    const w = "KEY=a.b+c*d?e^f$g(h)i|j[k]l\\m";
    const rest = `${w} CMD=run`;
    expect(psLineEnvMatches(rest, w)).toBe(true);
  });
});
