import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wireStatusLine } from "../settings-wire";

let tmp: string;
let settingsPath: string;
let statusPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-settings-wire-"));
  settingsPath = join(tmp, ".claude", "settings.json");
  statusPath = join(tmp, "state", "status.line");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("wireStatusLine - first-time setup (no settings.json)", () => {
  test("creates settings.json with statusLine entry", () => {
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.backupPath).toBeNull(); // nothing existed to back up
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.statusLine.command).toBe(`cat ${statusPath}`);
  });

  test("creates parent ~/.claude directory if missing", () => {
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    expect(existsSync(settingsPath)).toBe(true);
  });
});

describe("wireStatusLine - existing settings.json with other keys", () => {
  test("preserves unrelated keys when adding statusLine", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      env: { FOO: "bar" },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.theme).toBe("dark");
    expect(written.env).toEqual({ FOO: "bar" });
    expect(written.statusLine.command).toBe(`cat ${statusPath}`);
  });

  test("creates a backup file before writing", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.backupPath).not.toBeNull();
    expect(existsSync(r.backupPath!)).toBe(true);
    const backup = JSON.parse(readFileSync(r.backupPath!, "utf-8"));
    expect(backup.theme).toBe("dark");
    expect(backup.statusLine).toBeUndefined();
  });
});

describe("wireStatusLine - already-correct detection", () => {
  test("returns already-correct when settings already point at the same status file", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: `cat ${statusPath}` },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("already-correct");
  });
});

describe("wireStatusLine - conflict handling", () => {
  test("reports conflict when an unrelated statusLine command exists", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: "echo hello" },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.existingCommand).toBe("echo hello");
    // Original file untouched on conflict (no force).
    const stillThere = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(stillThere.statusLine.command).toBe("echo hello");
  });

  test("force=true overwrites existing statusLine and preserves siblings inside it", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: {
        command: "echo hello",
        someOtherKey: "preserved",
      },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath, force: true });
    expect(r.status).toBe("wired");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.statusLine.command).toBe(`cat ${statusPath}`);
    expect(written.statusLine.someOtherKey).toBe("preserved");
  });
});

describe("wireStatusLine - error paths", () => {
  test("returns error on malformed JSON without touching the file", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, "{ not valid json");
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.reason).toContain("not valid JSON");
    // File preserved as-is.
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ not valid json");
  });

  test("returns error when existing settings.json is a JSON array (not an object)", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(["array", "not", "object"]));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.reason).toContain("not an object");
  });

  test("empty file is treated like no file (creates fresh)", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, "   \n");
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
  });
});
