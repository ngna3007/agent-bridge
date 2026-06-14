import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPidAlive,
  enumerateStateDirs,
  tryKill,
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
