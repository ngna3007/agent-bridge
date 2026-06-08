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

  test("hasBeenAskedStatusLine is false by default", () => {
    expect(prefs.hasBeenAskedStatusLine()).toBe(false);
  });

  test("hasBeenAskedCaveman is false by default", () => {
    expect(prefs.hasBeenAskedCaveman()).toBe(false);
  });

  test("hasBeenAskedRtk is false by default", () => {
    expect(prefs.hasBeenAskedRtk()).toBe(false);
  });

  test("isCavemanOptedIn / isRtkOptedIn default to false", () => {
    expect(prefs.isCavemanOptedIn()).toBe(false);
    expect(prefs.isRtkOptedIn()).toBe(false);
  });
});

describe("UserPrefsService - onboarding flags round-trip", () => {
  test("caveman opt-in is persisted with its asked flag", () => {
    prefs.update({ cavemanAsked: true, cavemanOptIn: true });
    expect(prefs.hasBeenAskedCaveman()).toBe(true);
    expect(prefs.isCavemanOptedIn()).toBe(true);
  });

  test("rtk opt-in is persisted with its asked flag", () => {
    prefs.update({ rtkAsked: true, rtkOptIn: true });
    expect(prefs.hasBeenAskedRtk()).toBe(true);
    expect(prefs.isRtkOptedIn()).toBe(true);
  });

  test("asked-but-declined is distinguishable from never-asked", () => {
    // Important: a declined opt-in must still mark "asked" so we don't
    // pester the user every launch.
    prefs.update({ cavemanAsked: true, rtkAsked: true });
    expect(prefs.hasBeenAskedCaveman()).toBe(true);
    expect(prefs.hasBeenAskedRtk()).toBe(true);
    expect(prefs.isCavemanOptedIn()).toBe(false);
    expect(prefs.isRtkOptedIn()).toBe(false);
  });

  test("statusLineAsked persists and gates the prompt", () => {
    prefs.update({ statusLineAsked: true });
    expect(prefs.hasBeenAskedStatusLine()).toBe(true);
  });
});

describe("UserPrefsService - forward compatibility", () => {
  test("unknown keys on disk are preserved on save", () => {
    // Simulate a newer build wrote a field we don't know about.
    prefs.update({ statusLineAsked: true });
    const raw = JSON.parse(readFileSync(prefs.filePath, "utf-8"));
    raw.someFutureKey = "preserve-me";
    writeFileSync(prefs.filePath, JSON.stringify(raw, null, 2));

    // Now an update from this older code path should not strip the field.
    prefs.update({ cavemanAsked: true });

    const reloadedRaw = JSON.parse(readFileSync(prefs.filePath, "utf-8"));
    expect(reloadedRaw.someFutureKey).toBe("preserve-me");
    expect(reloadedRaw.statusLineAsked).toBe(true);
    expect(reloadedRaw.cavemanAsked).toBe(true);
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
