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
  test("creates settings.json with a fresh statusLine entry", () => {
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.backupPath).toBeNull();
    expect(r.command).toBe(`cat ${statusPath}`);
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
  test("preserves unrelated keys when adding a fresh statusLine", () => {
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
  test("returns already-correct when settings already points at the same status file (plain command)", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: `cat ${statusPath}` },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("already-correct");
  });

  test("returns already-correct when statusLine is a chained command we wrote previously", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const chained = `{ bash "/home/x/caveman.sh"; printf ' '; cat ${statusPath}; } | tr -d '\\n'`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: chained } }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("already-correct");
  });
});

describe("wireStatusLine - chaining onto an existing command", () => {
  test("chains by default instead of overwriting", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: 'bash "/home/x/caveman.sh"' },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("chained");
    if (r.status !== "chained") return;
    expect(r.previousCommand).toBe('bash "/home/x/caveman.sh"');
    // New command must invoke the existing command first, then cat ours.
    expect(r.command).toContain('bash "/home/x/caveman.sh"');
    expect(r.command).toContain(`cat ${statusPath}`);
    // Output is flattened to a single line.
    expect(r.command).toContain("tr -d '\\n'");
  });

  test("chained command preserves siblings inside the existing statusLine record", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: {
        command: 'bash "/home/x/caveman.sh"',
        someOtherKey: "preserved",
      },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("chained");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.statusLine.someOtherKey).toBe("preserved");
  });

  test("chain is idempotent: running twice does not double-wrap", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: 'bash "/home/x/caveman.sh"' },
    }));
    const first = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(first.status).toBe("chained");
    const second = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(second.status).toBe("already-correct");
    // settings.json command is unchanged on the second run.
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (first.status !== "chained") return;
    expect(written.statusLine.command).toBe(first.command);
  });

  test("force=true overwrites instead of chaining", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: 'bash "/home/x/caveman.sh"' },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath, force: true });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.command).toBe(`cat ${statusPath}`);
    expect(r.command).not.toContain("caveman");
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
