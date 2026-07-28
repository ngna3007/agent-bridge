import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncRolesForLaunch } from "../cli/role-sync";
import { instructionFilePath, roleFilePath, seedRoleFiles } from "../roles";

describe("syncRolesForLaunch", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentbridge-launch-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("no-ops outside a project - no marker, no files written", () => {
    syncRolesForLaunch("claude", root);
    expect(existsSync(instructionFilePath(root, "claude"))).toBe(false);
  });

  test("renders the launching agent's section inside a project", () => {
    mkdirSync(join(root, ".agentbridge"), { recursive: true });
    seedRoleFiles(root, ["claude"]);
    writeFileSync(roleFilePath(root, "claude"), "LAUNCH ROLE", "utf-8");

    syncRolesForLaunch("claude", root);

    expect(readFileSync(instructionFilePath(root, "claude"), "utf-8")).toContain("LAUNCH ROLE");
  });

  test("touches only the launching agent's instruction file", () => {
    mkdirSync(join(root, ".agentbridge"), { recursive: true });
    seedRoleFiles(root);

    syncRolesForLaunch("codex", root);

    expect(existsSync(instructionFilePath(root, "codex"))).toBe(true);
    expect(existsSync(instructionFilePath(root, "claude"))).toBe(false);
  });

  test("a broken role file for the other agent does not block this launch", () => {
    mkdirSync(join(root, ".agentbridge"), { recursive: true });
    seedRoleFiles(root);
    writeFileSync(roleFilePath(root, "codex"), "", "utf-8");

    expect(() => syncRolesForLaunch("claude", root)).not.toThrow();
    expect(existsSync(instructionFilePath(root, "claude"))).toBe(true);
  });

  test("is idempotent - a second launch rewrites nothing", () => {
    mkdirSync(join(root, ".agentbridge"), { recursive: true });
    seedRoleFiles(root, ["claude"]);

    syncRolesForLaunch("claude", root);
    const first = readFileSync(instructionFilePath(root, "claude"), "utf-8");
    syncRolesForLaunch("claude", root);

    expect(readFileSync(instructionFilePath(root, "claude"), "utf-8")).toBe(first);
  });
});
