import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RotatingLogger,
  getRotatingLogger,
  _resetLoggerCacheForTests,
} from "../log-rotator";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-log-rotator-"));
  _resetLoggerCacheForTests();
  delete process.env.AGENTBRIDGE_LOG_MAX_BYTES;
  delete process.env.AGENTBRIDGE_LOG_MAX_FILES;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _resetLoggerCacheForTests();
  delete process.env.AGENTBRIDGE_LOG_MAX_BYTES;
  delete process.env.AGENTBRIDGE_LOG_MAX_FILES;
});

describe("RotatingLogger — basic writes", () => {
  test("creates the file on first write", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 1024, maxFiles: 3 });
    r.write("hello\n");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hello\n");
  });

  test("accumulates the byte counter accurately", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 1024, maxFiles: 3 });
    r.write("abc\n");
    r.write("defg\n");
    expect(r.getBytesWritten()).toBe(9);
    expect(statSync(p).size).toBe(9);
  });

  test("counts utf8 bytes, not characters", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 1024, maxFiles: 3 });
    r.write("日本\n"); // 6 utf8 bytes for "日本" + 1 for "\n" = 7
    expect(r.getBytesWritten()).toBe(7);
    expect(statSync(p).size).toBe(7);
  });
});

describe("RotatingLogger — rotation trigger", () => {
  test("rotates when a write would exceed the cap", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 10, maxFiles: 3 });
    r.write("12345\n"); // 6 bytes, under cap
    r.write("67890\n"); // would push to 12, > 10 → rotate first
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(`${p}.1`, "utf8")).toBe("12345\n");
    expect(readFileSync(p, "utf8")).toBe("67890\n");
    expect(r.getBytesWritten()).toBe(6);
  });

  test("does not rotate when writes stay under the cap", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    for (let i = 0; i < 5; i++) r.write("x\n");
    expect(existsSync(`${p}.1`)).toBe(false);
    expect(statSync(p).size).toBe(10);
  });

  test("rotates multiple times when writes keep exceeding cap", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 5, maxFiles: 3 });
    r.write("aaaa\n"); // 5 bytes, fits
    r.write("bbbb\n"); // would push to 10 > 5 → rotate
    r.write("cccc\n"); // would push to 10 > 5 → rotate again
    expect(readFileSync(p, "utf8")).toBe("cccc\n");
    expect(readFileSync(`${p}.1`, "utf8")).toBe("bbbb\n");
    expect(readFileSync(`${p}.2`, "utf8")).toBe("aaaa\n");
  });
});

describe("RotatingLogger — generation chain", () => {
  test("shifts generations down on each rotation", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 5, maxFiles: 3 });
    r.write("AAAA\n");
    r.rotate();
    r.write("BBBB\n");
    r.rotate();
    r.write("CCCC\n");
    r.rotate();
    r.write("DDDD\n");
    expect(readFileSync(p, "utf8")).toBe("DDDD\n");
    expect(readFileSync(`${p}.1`, "utf8")).toBe("CCCC\n");
    expect(readFileSync(`${p}.2`, "utf8")).toBe("BBBB\n");
    expect(readFileSync(`${p}.3`, "utf8")).toBe("AAAA\n");
  });

  test("drops the oldest generation when maxFiles is exceeded", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 5, maxFiles: 2 });
    r.write("AAAA\n");
    r.rotate();
    r.write("BBBB\n");
    r.rotate();
    r.write("CCCC\n");
    r.rotate();
    r.write("DDDD\n");
    expect(readFileSync(p, "utf8")).toBe("DDDD\n");
    expect(readFileSync(`${p}.1`, "utf8")).toBe("CCCC\n");
    expect(readFileSync(`${p}.2`, "utf8")).toBe("BBBB\n");
    expect(existsSync(`${p}.3`)).toBe(false);
  });

  test("rotation with no existing file is a no-op (does not throw)", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    expect(() => r.rotate()).not.toThrow();
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.1`)).toBe(false);
  });
});

describe("RotatingLogger — startup oversize guard", () => {
  test("rotates an existing oversize file on construct", () => {
    const p = join(tmp, "x.log");
    writeFileSync(p, "X".repeat(1000));
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    expect(existsSync(p)).toBe(false); // rotated away
    expect(readFileSync(`${p}.1`, "utf8").length).toBe(1000);
    expect(r.getBytesWritten()).toBe(0);
  });

  test("leaves an existing under-cap file in place and seeds counter", () => {
    const p = join(tmp, "x.log");
    writeFileSync(p, "preexisting\n");
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    expect(existsSync(p)).toBe(true);
    expect(r.getBytesWritten()).toBe(12);
  });

  test("oversize seeded counter still triggers rotation on next write", () => {
    // Counter seeded above cap → first write must rotate even though
    // startup guard already rotated once. (Edge case: seed > cap but rotate
    // resets to 0, so this is really testing the seed-then-rotate sequence.)
    const p = join(tmp, "x.log");
    writeFileSync(p, "X".repeat(200));
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    r.write("new\n");
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(readFileSync(`${p}.1`, "utf8").length).toBe(200);
  });
});

describe("RotatingLogger — env config", () => {
  test("AGENTBRIDGE_LOG_MAX_BYTES overrides default", () => {
    // Must be at or above MIN_MAX_BYTES (1024) or it gets rejected as a typo.
    process.env.AGENTBRIDGE_LOG_MAX_BYTES = "1024";
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p);
    r.write("X".repeat(500) + "\n"); // 501 bytes
    r.write("X".repeat(600) + "\n"); // 501 + 601 = 1102 > 1024 → rotate
    expect(existsSync(`${p}.1`)).toBe(true);
  });

  test("AGENTBRIDGE_LOG_MAX_FILES overrides default", () => {
    process.env.AGENTBRIDGE_LOG_MAX_BYTES = "5";
    process.env.AGENTBRIDGE_LOG_MAX_FILES = "1";
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p);
    r.write("AAAA\n");
    r.rotate();
    r.write("BBBB\n");
    r.rotate();
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(existsSync(`${p}.2`)).toBe(false);
  });

  test("invalid env values fall back to defaults", () => {
    process.env.AGENTBRIDGE_LOG_MAX_BYTES = "not-a-number";
    process.env.AGENTBRIDGE_LOG_MAX_FILES = "-5";
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p);
    // With defaults (50MB), a small write should NOT rotate.
    r.write("hello\n");
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  test("explicit opts beat env vars", () => {
    process.env.AGENTBRIDGE_LOG_MAX_BYTES = "1000000";
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 5 });
    r.write("AAAA\n");
    r.write("BBBB\n"); // > 5 → rotate
    expect(existsSync(`${p}.1`)).toBe(true);
  });

  test("env maxBytes below MIN is rejected — fallback applies (typo safety)", () => {
    // Env values are user-tunable so we guard against typos like "10"
    // when the user meant "10000000". Explicit opts are trusted (tests).
    process.env.AGENTBRIDGE_LOG_MAX_BYTES = "5"; // 5 is below the env min
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p);
    r.write("hello\n");
    // With default 50MB cap applied, a 6-byte write must not rotate.
    expect(existsSync(`${p}.1`)).toBe(false);
  });
});

describe("RotatingLogger — never-throws contract", () => {
  test("write to an unwritable path silently succeeds", () => {
    // Path under a non-existent directory — appendFileSync would normally
    // throw ENOENT. The logger must swallow it.
    const p = join(tmp, "does-not-exist", "x.log");
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    expect(() => r.write("hello\n")).not.toThrow();
  });

  test("rotate against a missing file does not throw", () => {
    const p = join(tmp, "x.log");
    const r = new RotatingLogger(p, { maxBytes: 100, maxFiles: 3 });
    expect(() => r.rotate()).not.toThrow();
    expect(() => r.rotate()).not.toThrow();
  });
});

describe("getRotatingLogger — singleton cache", () => {
  test("returns the same instance for the same path", () => {
    const p = join(tmp, "x.log");
    const a = getRotatingLogger(p, { maxBytes: 1024 });
    const b = getRotatingLogger(p);
    expect(a).toBe(b);
  });

  test("returns different instances for different paths", () => {
    const a = getRotatingLogger(join(tmp, "a.log"));
    const b = getRotatingLogger(join(tmp, "b.log"));
    expect(a).not.toBe(b);
  });

  test("singleton counter is shared across callers", () => {
    const p = join(tmp, "x.log");
    const a = getRotatingLogger(p, { maxBytes: 1024 });
    a.write("from-a\n");
    const b = getRotatingLogger(p);
    expect(b.getBytesWritten()).toBe(7);
    // Both refs see the rotation when triggered.
    b.write("more\n");
    expect(a.getBytesWritten()).toBe(12);
  });

  test("_resetLoggerCacheForTests clears the cache", () => {
    const p = join(tmp, "x.log");
    const a = getRotatingLogger(p);
    _resetLoggerCacheForTests();
    const b = getRotatingLogger(p);
    expect(a).not.toBe(b);
  });
});
