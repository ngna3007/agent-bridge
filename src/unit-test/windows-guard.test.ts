import { describe, expect, test } from "bun:test";
import {
  ALLOW_NATIVE_WINDOWS_ENV,
  assertSupportedPlatform,
  checkPlatformSupport,
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
