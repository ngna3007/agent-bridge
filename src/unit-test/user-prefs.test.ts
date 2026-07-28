import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserPrefsService } from "../user-prefs";
import { StateDirResolver } from "../state-dir";

let tmp: string;
let prefs: UserPrefsService;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-user-prefs-"));
  prefs = new UserPrefsService(new StateDirResolver(tmp));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("UserPrefsService - defaults", () => {
  test("load() on a missing file returns empty object", () => {
    expect(prefs.load()).toEqual({});
  });

  test("hasAcknowledgedIntro is false by default", () => {
    expect(prefs.hasAcknowledgedIntro()).toBe(false);
  });
});

describe("UserPrefsService - round-trip", () => {
  test("introAcknowledged is persisted and reread", () => {
    prefs.update({ introAcknowledged: true });
    const fresh = new UserPrefsService(new StateDirResolver(tmp));
    expect(fresh.hasAcknowledgedIntro()).toBe(true);
  });
});

describe("UserPrefsService - forward compatibility", () => {
  test("unknown keys on disk are preserved on save", () => {
    // Simulate a future build wrote a field we don't know about.
    prefs.update({ introAcknowledged: true });
    const raw = JSON.parse(readFileSync(prefs.filePath, "utf-8"));
    raw.someFutureKey = "preserve-me";
    writeFileSync(prefs.filePath, JSON.stringify(raw, null, 2));

    // An update from this older code path should not strip the field.
    prefs.update({});

    const reloadedRaw = JSON.parse(readFileSync(prefs.filePath, "utf-8"));
    expect(reloadedRaw.someFutureKey).toBe("preserve-me");
    expect(reloadedRaw.introAcknowledged).toBe(true);
  });

  test("legacy fields from older builds survive a write", () => {
    // Older build wrote cavemanOptIn, statusLineAsked, etc.
    writeFileSync(prefs.filePath, JSON.stringify({
      introAcknowledged: false,
      cavemanOptIn: true,
      statusLineAsked: true,
    }));
    prefs.update({ introAcknowledged: true });
    const reloadedRaw = JSON.parse(readFileSync(prefs.filePath, "utf-8"));
    expect(reloadedRaw.cavemanOptIn).toBe(true);
    expect(reloadedRaw.statusLineAsked).toBe(true);
    expect(reloadedRaw.introAcknowledged).toBe(true);
  });

  test("non-object JSON is treated as empty prefs", () => {
    writeFileSync(prefs.filePath, JSON.stringify(["array"]));
    expect(prefs.load()).toEqual({});
  });

  test("malformed JSON is treated as empty prefs (never throws)", () => {
    writeFileSync(prefs.filePath, "{ not json");
    expect(() => prefs.load()).not.toThrow();
    expect(prefs.load()).toEqual({});
  });
});

describe("UserPrefsService - setup decline list", () => {
  test("hasDeclinedSetup is false for an unseen directory", () => {
    expect(prefs.hasDeclinedSetup("/work/repo")).toBe(false);
  });

  test("recordSetupDeclined persists and rereads", () => {
    prefs.recordSetupDeclined("/work/repo");
    const fresh = new UserPrefsService(new StateDirResolver(tmp));
    expect(fresh.hasDeclinedSetup("/work/repo")).toBe(true);
  });

  test("declining one directory does not decline another", () => {
    prefs.recordSetupDeclined("/work/repo");
    expect(prefs.hasDeclinedSetup("/work/other")).toBe(false);
  });

  test("recordSetupDeclined is idempotent - no duplicate entries", () => {
    prefs.recordSetupDeclined("/work/repo");
    prefs.recordSetupDeclined("/work/repo");
    expect(prefs.load().setupDeclinedPaths).toEqual(["/work/repo"]);
  });

  test("multiple declines accumulate", () => {
    prefs.recordSetupDeclined("/a");
    prefs.recordSetupDeclined("/b");
    expect(prefs.load().setupDeclinedPaths).toEqual(["/a", "/b"]);
  });

  // The decline list must not clobber, or be clobbered by, the intro
  // flag - both live in one file and are written by separate paths.
  test("decline list and introAcknowledged coexist", () => {
    prefs.update({ introAcknowledged: true });
    prefs.recordSetupDeclined("/work/repo");
    const fresh = new UserPrefsService(new StateDirResolver(tmp));
    expect(fresh.hasAcknowledgedIntro()).toBe(true);
    expect(fresh.hasDeclinedSetup("/work/repo")).toBe(true);
  });

  // A corrupt entry should cost one re-prompt, not every pref in the
  // file.
  test("non-string entries are dropped, valid ones survive", () => {
    writeFileSync(
      prefs.filePath,
      JSON.stringify({ setupDeclinedPaths: ["/good", 42, null, "/also-good"] }),
      "utf-8",
    );
    expect(prefs.load().setupDeclinedPaths).toEqual(["/good", "/also-good"]);
  });

  test("a non-array setupDeclinedPaths is ignored rather than throwing", () => {
    writeFileSync(prefs.filePath, JSON.stringify({ setupDeclinedPaths: "nope" }), "utf-8");
    expect(prefs.load().setupDeclinedPaths).toBeUndefined();
    expect(prefs.hasDeclinedSetup("/anything")).toBe(false);
  });
});
