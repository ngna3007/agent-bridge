import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusLineWriter } from "../status-line-writer";
import { StateDirResolver } from "../state-dir";

let tmp: string;
let writer: StatusLineWriter;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-status-line-"));
  writer = new StatusLineWriter(new StateDirResolver(tmp));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("StatusLineWriter - basic writes", () => {
  test("writes a single line containing timestamp + message", () => {
    writer.write({ message: "codex ready", timestamp: "2026-01-01T00:00:00Z" });
    const content = readFileSync(writer.filePath, "utf-8");
    expect(content).toBe("2026-01-01T00:00:00Z\tcodex ready\n");
  });

  test("auto-generates timestamp when omitted", () => {
    writer.write({ message: "hello" });
    const content = readFileSync(writer.filePath, "utf-8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("\thello\n");
  });

  test("overwrites previous content on each call", () => {
    writer.write({ message: "first", timestamp: "2026-01-01T00:00:00Z" });
    writer.write({ message: "second", timestamp: "2026-01-01T00:00:01Z" });
    const content = readFileSync(writer.filePath, "utf-8");
    expect(content).toBe("2026-01-01T00:00:01Z\tsecond\n");
    // No trace of "first" left behind.
    expect(content).not.toContain("first");
  });
});

describe("StatusLineWriter - newline flattening", () => {
  test("LF in message is collapsed to a space", () => {
    writer.write({ message: "line1\nline2", timestamp: "2026-01-01T00:00:00Z" });
    expect(readFileSync(writer.filePath, "utf-8")).toBe("2026-01-01T00:00:00Z\tline1 line2\n");
  });

  test("CRLF in message is collapsed too", () => {
    writer.write({ message: "a\r\nb", timestamp: "2026-01-01T00:00:00Z" });
    expect(readFileSync(writer.filePath, "utf-8")).toBe("2026-01-01T00:00:00Z\ta b\n");
  });

  test("trims leading/trailing whitespace from message", () => {
    writer.write({ message: "  padded  ", timestamp: "2026-01-01T00:00:00Z" });
    expect(readFileSync(writer.filePath, "utf-8")).toBe("2026-01-01T00:00:00Z\tpadded\n");
  });
});

describe("StatusLineWriter - clear", () => {
  test("clear empties the file", () => {
    writer.write({ message: "before" });
    writer.clear();
    expect(readFileSync(writer.filePath, "utf-8")).toBe("");
  });

  test("clear on a missing file is a no-op (no throw)", () => {
    expect(() => writer.clear()).not.toThrow();
  });
});

describe("StatusLineWriter - never throws contract", () => {
  test("write to an unwritable path silently degrades", () => {
    const bad = new StatusLineWriter(new StateDirResolver("/dev/null/cannot-write"));
    expect(() => bad.write({ message: "x" })).not.toThrow();
    expect(existsSync(bad.filePath)).toBe(false);
  });
});
