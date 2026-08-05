import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOW_NATIVE_WINDOWS_ENV,
  assertSupportedPlatform,
  checkPlatformSupport,
  commandNeedsSupportedPlatform,
} from "../windows-guard";

describe("checkPlatformSupport", () => {
  test("linux proceeds — this covers WSL2, where platform() is linux", () => {
    expect(checkPlatformSupport("linux", {})).toEqual({ action: "proceed" });
  });

  test("darwin proceeds", () => {
    expect(checkPlatformSupport("darwin", {})).toEqual({ action: "proceed" });
  });

  test("win32 refuses", () => {
    expect(checkPlatformSupport("win32", {}).action).toBe("refuse");
  });

  test("the refusal names WSL2 and the docs page, not just the failure", () => {
    const verdict = checkPlatformSupport("win32", {});
    expect(verdict.action).toBe("refuse");
    if (verdict.action !== "refuse") return;
    expect(verdict.message).toContain("wsl --install");
    // A repo-relative path is unreadable to someone who installed from
    // npm and has no checkout, which is everyone this message reaches.
    expect(verdict.message).toContain("https://github.com/");
    expect(verdict.message).toContain("docs/windows.md");
  });

  test("the override downgrades the refusal to a warning", () => {
    const verdict = checkPlatformSupport("win32", { [ALLOW_NATIVE_WINDOWS_ENV]: "1" });
    expect(verdict.action).toBe("warn");
  });

  test("the override warns that it is unsupported rather than implying it works", () => {
    const verdict = checkPlatformSupport("win32", { [ALLOW_NATIVE_WINDOWS_ENV]: "1" });
    if (verdict.action !== "warn") throw new Error("expected a warning");
    expect(verdict.message).toContain("Unsupported");
  });

  test("only the exact value 1 overrides — a stray 'true' or '0' still refuses", () => {
    expect(checkPlatformSupport("win32", { [ALLOW_NATIVE_WINDOWS_ENV]: "true" }).action).toBe(
      "refuse",
    );
    expect(checkPlatformSupport("win32", { [ALLOW_NATIVE_WINDOWS_ENV]: "0" }).action).toBe(
      "refuse",
    );
  });

  test("the override is not readable from an unrelated variable", () => {
    expect(checkPlatformSupport("win32", { AGENTBRIDGE_ACTIVE: "1" }).action).toBe("refuse");
  });
});

describe("commandNeedsSupportedPlatform", () => {
  test("help and version are exempt — the person being turned away is the one who needs them", () => {
    for (const cmd of ["--help", "-h", "--version", "-v"]) {
      expect(commandNeedsSupportedPlatform(cmd)).toBe(false);
    }
  });

  test("a bare `abg` prints help, so it is exempt too", () => {
    expect(commandNeedsSupportedPlatform(undefined)).toBe(false);
  });

  test("every command that spawns, talks to the daemon, or writes state is gated", () => {
    for (const cmd of [
      "init",
      "dev",
      "claude",
      "codex",
      "kill",
      "status",
      "projects",
      "doctor",
      "log",
      "logs",
      "roles",
    ]) {
      expect(commandNeedsSupportedPlatform(cmd)).toBe(true);
    }
  });

  test("an unknown command is gated, not exempted by default", () => {
    expect(commandNeedsSupportedPlatform("banana")).toBe(true);
  });

  test("the exemption is exact — `--helpme` is not `--help`", () => {
    expect(commandNeedsSupportedPlatform("--helpme")).toBe(true);
    expect(commandNeedsSupportedPlatform("help")).toBe(true);
  });
});

describe("assertSupportedPlatform", () => {
  test("on a supported platform it writes nothing and does not exit", () => {
    const written: string[] = [];
    let exited: number | null = null;
    assertSupportedPlatform(
      (s) => written.push(s),
      ((code: number) => {
        exited = code;
      }) as (code: number) => never,
    );
    // The suite runs on linux/darwin; a win32 CI box would legitimately
    // see the refusal, so assert on the platform we are actually on.
    if (process.platform === "win32") return;
    expect(written).toEqual([]);
    expect(exited).toBeNull();
  });
});

/**
 * Entry-point wiring.
 *
 * Both process entry points have to reach the guard, and neither can be
 * executed down its win32 path from this suite — the decision reads the
 * real `platform()`. What can be pinned is that the call exists and sits
 * ahead of the work it protects, which is what actually regresses: a
 * later refactor moving an import or reordering `main()` would leave the
 * policy function fully tested and unreachable.
 */
describe("entry-point wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
  const bridge = readFileSync(join(import.meta.dir, "..", "bridge.ts"), "utf8");

  test("cli.ts gates the guard on the command classifier rather than calling it flat", () => {
    expect(cli).toContain("commandNeedsSupportedPlatform(command)");
    expect(cli).toContain("assertSupportedPlatform()");
  });

  test("cli.ts guards before the first-run setup offer, which writes to disk", () => {
    expect(cli.indexOf("assertSupportedPlatform()")).toBeLessThan(cli.indexOf("maybeOfferSetup"));
  });

  test("bridge.ts guards too — Claude Code loads it without the CLI ever running", () => {
    expect(bridge).toContain("assertSupportedPlatform()");
  });

  // Not "before the imports" — ESM hoists those, so the modules below
  // are evaluated first no matter where the call sits. What the guard
  // can and must precede is the first top-level statement with a side
  // effect, which is the one that creates the state directory.
  test("bridge.ts guards before it creates the state directory", () => {
    // Anchored to the start of a line so the prose above — which names
    // both calls — cannot satisfy either search.
    const lineOf = (re: RegExp) => bridge.split("\n").findIndex((l) => re.test(l));
    const guard = lineOf(/^assertSupportedPlatform\(\);/);
    const ensure = lineOf(/^stateDir\.ensure\(\);/);
    expect(guard).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(ensure);
  });

  test("bridge.ts guards unconditionally — it has no command to classify", () => {
    expect(bridge).not.toContain("commandNeedsSupportedPlatform");
  });
});
