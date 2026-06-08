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
  test("creates settings.json with a fresh, env-gated statusLine entry", () => {
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.backupPath).toBeNull();
    // Env-gated: the cat only runs when AGENTBRIDGE_ACTIVE=1 (set by
    // `abg claude`). Plain claude sessions see nothing.
    expect(r.command).toContain('"$AGENTBRIDGE_ACTIVE" = "1"');
    expect(r.command).toContain(`cat ${statusPath}`);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.statusLine.command).toBe(r.command);
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
    expect(written.statusLine.command).toContain('"$AGENTBRIDGE_ACTIVE" = "1"');
    expect(written.statusLine.command).toContain(`cat ${statusPath}`);
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

describe("wireStatusLine - already-correct detection (gated format only)", () => {
  test("returns already-correct when settings already uses the current gated chain", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const gatedChain = `{ bash "/home/x/caveman.sh"; [ "$AGENTBRIDGE_ACTIVE" = "1" ] && { printf ' '; cat ${statusPath}; }; } | tr -d '\\n'`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: gatedChain } }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("already-correct");
  });

  test("returns already-correct when settings already uses the gated standalone", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const gatedStandalone = `[ "$AGENTBRIDGE_ACTIVE" = "1" ] && cat ${statusPath}`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: gatedStandalone } }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("already-correct");
  });
});

describe("wireStatusLine - migration from old ungated formats", () => {
  test("migrates the old ungated chain (no $AGENTBRIDGE_ACTIVE gate) to the new gated chain", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const oldChain = `{ bash "/home/x/caveman.sh"; printf ' '; cat ${statusPath}; } | tr -d '\\n'`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: oldChain } }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("chained");
    if (r.status !== "chained") return;
    // Migration reconstructs from the user's original prefix command,
    // not by nesting another chain around the old chain.
    expect(r.previousCommand).toBe('bash "/home/x/caveman.sh"');
    expect(r.command).toContain('"$AGENTBRIDGE_ACTIVE" = "1"');
    expect(r.command).toContain(`cat ${statusPath}`);
    // No nested wrapping: the only occurrence of "{ " should be the
    // outermost group.
    expect(r.command.match(/\{ /g)!.length).toBe(2); // outer + inner (gate's && {)
    expect(r.command).not.toContain(oldChain); // not nested
  });

  test("migrates the old ungated standalone (plain cat) to the gated standalone", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: `cat ${statusPath}` },
    }));
    const r = wireStatusLine({ settingsPath, statusFilePath: statusPath });
    expect(r.status).toBe("wired");
    if (r.status !== "wired") return;
    expect(r.command).toContain('"$AGENTBRIDGE_ACTIVE" = "1"');
    expect(r.command).toContain(`cat ${statusPath}`);
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
    expect(r.command).toContain('"$AGENTBRIDGE_ACTIVE" = "1"');
    expect(r.command).toContain(`cat ${statusPath}`);
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
