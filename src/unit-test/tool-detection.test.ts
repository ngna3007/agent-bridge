import { describe, expect, test } from "bun:test";
import { detectRtk, detectCaveman, type CommandRunner } from "../cli/tool-detection";

function mockRunner(table: Record<string, string | null>): CommandRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    return key in table ? table[key] : null;
  };
}

describe("detectRtk", () => {
  test("not installed when 'which rtk' returns null", () => {
    const r = detectRtk({ runCommand: mockRunner({}) });
    expect(r.installed).toBe(false);
    expect(r.note).toContain("not on PATH");
  });

  test("installed when 'which rtk' resolves and --version reports rtk", () => {
    const r = detectRtk({
      runCommand: mockRunner({
        "which rtk": "/usr/local/bin/rtk",
        "/usr/local/bin/rtk --version": "rtk 0.4.2",
      }),
    });
    expect(r.installed).toBe(true);
    expect(r.path).toBe("/usr/local/bin/rtk");
    expect(r.version).toBe("rtk 0.4.2");
  });

  test("not installed when --version reports a different rtk", () => {
    // reachingforthejack/rtk (Rust Type Kit) collision case.
    const r = detectRtk({
      runCommand: mockRunner({
        "which rtk": "/usr/local/bin/rtk",
        "/usr/local/bin/rtk --version": "Rust Type Kit (rtk) v1.0",
      }),
    });
    expect(r.installed).toBe(false);
    expect(r.path).toBe("/usr/local/bin/rtk");
    expect(r.note).toContain("wrong rtk");
  });

  test("not installed when --version fails to run", () => {
    const r = detectRtk({
      runCommand: mockRunner({
        "which rtk": "/usr/local/bin/rtk",
        // no --version entry => null returned
      }),
    });
    expect(r.installed).toBe(false);
    expect(r.note).toContain("--version failed");
  });

  test("version regex requires a number after 'rtk '", () => {
    // Defensive: a binary that prints just "rtk" with no version digits
    // should not be counted as a valid install.
    const r = detectRtk({
      runCommand: mockRunner({
        "which rtk": "/usr/local/bin/rtk",
        "/usr/local/bin/rtk --version": "rtk help",
      }),
    });
    expect(r.installed).toBe(false);
  });
});

describe("detectCaveman", () => {
  test("not installed when no caveman bundle is found", () => {
    const r = detectCaveman({
      homeDir: "/fake/home",
      fileExists: () => false,
    });
    expect(r.installed).toBe(false);
    expect(r.note).toContain("not found");
  });

  test("installed when ~/.claude/skills/caveman exists", () => {
    const r = detectCaveman({
      homeDir: "/fake/home",
      fileExists: (p) => p === "/fake/home/.claude/skills/caveman",
    });
    expect(r.installed).toBe(true);
    expect(r.path).toBe("/fake/home/.claude/skills/caveman");
  });

  test("installed when ~/.claude/plugins/caveman exists", () => {
    const r = detectCaveman({
      homeDir: "/fake/home",
      fileExists: (p) => p === "/fake/home/.claude/plugins/caveman",
    });
    expect(r.installed).toBe(true);
    expect(r.path).toBe("/fake/home/.claude/plugins/caveman");
  });

  test("installed when only the caveman-marketplace cache is present", () => {
    const r = detectCaveman({
      homeDir: "/fake/home",
      fileExists: (p) =>
        p === "/fake/home/.claude/plugins/cache" ||
        p === "/fake/home/.claude/plugins/cache/caveman-marketplace",
    });
    expect(r.installed).toBe(true);
    expect(r.path).toContain("caveman-marketplace");
  });

  test("skills/ dir takes precedence over the cache layout", () => {
    const r = detectCaveman({
      homeDir: "/fake/home",
      fileExists: (p) =>
        p === "/fake/home/.claude/skills/caveman" ||
        p === "/fake/home/.claude/plugins/cache" ||
        p === "/fake/home/.claude/plugins/cache/caveman-marketplace",
    });
    expect(r.installed).toBe(true);
    expect(r.path).toBe("/fake/home/.claude/skills/caveman");
  });
});
