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
  test("writes the tag verbatim followed by a single newline", () => {
    writer.write("[CODEX]");
    expect(readFileSync(writer.filePath, "utf-8")).toBe("[CODEX]\n");
  });

  test("overwrites previous content on each call", () => {
    writer.write("[CODEX]");
    writer.write("[OFFLINE]");
    expect(readFileSync(writer.filePath, "utf-8")).toBe("[OFFLINE]\n");
  });
});

describe("StatusLineWriter - newline flattening", () => {
  test("LF inside the tag is collapsed to a space", () => {
    writer.write("line1\nline2");
    expect(readFileSync(writer.filePath, "utf-8")).toBe("line1 line2\n");
  });

  test("CRLF is collapsed too", () => {
    writer.write("a\r\nb");
    expect(readFileSync(writer.filePath, "utf-8")).toBe("a b\n");
  });

  test("leading and trailing whitespace is trimmed", () => {
    writer.write("  [CODEX]  ");
    expect(readFileSync(writer.filePath, "utf-8")).toBe("[CODEX]\n");
  });
});

describe("StatusLineWriter - clear", () => {
  test("clear empties the file", () => {
    writer.write("[CODEX]");
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
    expect(() => bad.write("x")).not.toThrow();
    expect(existsSync(bad.filePath)).toBe(false);
  });
});
