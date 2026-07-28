import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ROLE_AGENTS,
  RoleFileError,
  instructionFilePath,
  missingRoutingMarkers,
  readRoleText,
  roleFilePath,
  rolesDir,
  seedRoleFiles,
  seededRoleText,
  syncRoleSections,
  writeDefaultRoleFile,
} from "../roles";
import {
  MARKER_ID,
  CLAUDE_MD_SECTION,
  AGENTS_MD_SECTION,
} from "../collaboration-content";

const START = `<!-- ${MARKER_ID}:start -->`;
const END = `<!-- ${MARKER_ID}:end -->`;

describe("roles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentbridge-roles-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("seedRoleFiles", () => {
    test("creates one file per agent with the built-in default text", () => {
      const outcomes = seedRoleFiles(root);

      expect(outcomes.map((o) => o.agent)).toEqual([...ROLE_AGENTS]);
      expect(outcomes.every((o) => o.created)).toBe(true);

      const claude = readFileSync(roleFilePath(root, "claude"), "utf-8");
      const codex = readFileSync(roleFilePath(root, "codex"), "utf-8");
      expect(claude).toContain(CLAUDE_MD_SECTION);
      expect(codex).toContain(AGENTS_MD_SECTION);
    });

    test("writes a pointer banner naming the file as the source", () => {
      seedRoleFiles(root);
      const claude = readFileSync(roleFilePath(root, "claude"), "utf-8");
      expect(claude).toContain(".agentbridge/roles/claude.md");
      expect(claude).toContain("abg claude");
    });

    test("creates the roles directory when missing", () => {
      seedRoleFiles(root);
      expect(readFileSync(join(rolesDir(root), "claude.md"), "utf-8").length).toBeGreaterThan(0);
    });

    test("never overwrites an existing role file", () => {
      seedRoleFiles(root);
      const path = roleFilePath(root, "claude");
      writeFileSync(path, "my own role", "utf-8");

      const outcomes = seedRoleFiles(root);

      expect(outcomes.find((o) => o.agent === "claude")?.created).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe("my own role");
    });

    test("is idempotent across repeated runs", () => {
      seedRoleFiles(root);
      const before = readFileSync(roleFilePath(root, "codex"), "utf-8");
      seedRoleFiles(root);
      seedRoleFiles(root);
      expect(readFileSync(roleFilePath(root, "codex"), "utf-8")).toBe(before);
    });

    test("seeds only the requested agents", () => {
      const outcomes = seedRoleFiles(root, ["codex"]);

      expect(outcomes).toHaveLength(1);
      expect(readFileSync(roleFilePath(root, "codex"), "utf-8")).toBe(seededRoleText("codex"));
      expect(() => readFileSync(roleFilePath(root, "claude"), "utf-8")).toThrow();
    });

    test("writes exactly seededRoleText, so 'still stock' is detectable", () => {
      seedRoleFiles(root);
      for (const agent of ROLE_AGENTS) {
        expect(readFileSync(roleFilePath(root, agent), "utf-8")).toBe(seededRoleText(agent));
      }
    });
  });

  describe("writeDefaultRoleFile", () => {
    test("overwrites customized text with the seeded default", () => {
      seedRoleFiles(root, ["codex"]);
      writeFileSync(roleFilePath(root, "codex"), "my own role", "utf-8");

      const path = writeDefaultRoleFile(root, "codex");

      expect(path).toBe(roleFilePath(root, "codex"));
      expect(readFileSync(path, "utf-8")).toBe(seededRoleText("codex"));
    });

    test("creates the roles directory when it does not exist", () => {
      const path = writeDefaultRoleFile(root, "claude");
      expect(readFileSync(path, "utf-8")).toBe(seededRoleText("claude"));
    });
  });

  describe("missingRoutingMarkers", () => {
    test("reports nothing for the built-in default of each agent", () => {
      for (const agent of ROLE_AGENTS) {
        expect(missingRoutingMarkers(seededRoleText(agent), agent)).toEqual([]);
      }
    });

    test("reports markers the default explains but a rewrite dropped", () => {
      const missing = missingRoutingMarkers("You are a reviewer. Be terse.", "codex");
      expect(missing).toContain("[REPLY]");
    });

    test("never reports a marker the agent's own default does not mention", () => {
      // Whatever the defaults say, the baseline is per-agent: a marker
      // absent from the stock role must not fire on an untouched project.
      for (const agent of ROLE_AGENTS) {
        for (const marker of missingRoutingMarkers("", agent)) {
          expect(seededRoleText(agent)).toContain(marker);
        }
      }
    });
  });

  describe("readRoleText", () => {
    test("falls back to the built-in default when the file is missing", () => {
      const result = readRoleText(root, "claude");
      expect(result.fromDefault).toBe(true);
      expect(result.text).toBe(CLAUDE_MD_SECTION);
    });

    test("returns the file body verbatim when present", () => {
      mkdirSync(rolesDir(root), { recursive: true });
      writeFileSync(roleFilePath(root, "codex"), "You are a reviewer.\n", "utf-8");

      const result = readRoleText(root, "codex");
      expect(result.fromDefault).toBe(false);
      expect(result.text).toBe("You are a reviewer.");
    });

    test("throws for an empty file rather than silently using the default", () => {
      mkdirSync(rolesDir(root), { recursive: true });
      writeFileSync(roleFilePath(root, "claude"), "   \n\n", "utf-8");

      expect(() => readRoleText(root, "claude")).toThrow(RoleFileError);
      try {
        readRoleText(root, "claude");
      } catch (err) {
        expect((err as RoleFileError).path).toBe(roleFilePath(root, "claude"));
      }
    });
  });

  describe("syncRoleSections", () => {
    test("creates instruction files carrying the role text", () => {
      seedRoleFiles(root);
      writeFileSync(roleFilePath(root, "claude"), "ROLE-A", "utf-8");
      writeFileSync(roleFilePath(root, "codex"), "ROLE-B", "utf-8");

      const outcomes = syncRoleSections(root);
      expect(outcomes.map((o) => o.status)).toEqual(["created", "created"]);

      expect(readFileSync(instructionFilePath(root, "claude"), "utf-8")).toBe(
        `${START}\nROLE-A\n${END}\n`,
      );
      expect(readFileSync(instructionFilePath(root, "codex"), "utf-8")).toBe(
        `${START}\nROLE-B\n${END}\n`,
      );
    });

    test("is idempotent - a second call reports unchanged and rewrites nothing", () => {
      seedRoleFiles(root);
      syncRoleSections(root);
      const before = readFileSync(instructionFilePath(root, "claude"), "utf-8");

      const outcomes = syncRoleSections(root);
      expect(outcomes.every((o) => o.status === "unchanged")).toBe(true);
      expect(readFileSync(instructionFilePath(root, "claude"), "utf-8")).toBe(before);
    });

    test("re-renders after the role file is edited", () => {
      seedRoleFiles(root);
      syncRoleSections(root);

      writeFileSync(roleFilePath(root, "claude"), "EDITED ROLE", "utf-8");
      const outcomes = syncRoleSections(root, { agents: ["claude"] });

      expect(outcomes[0].status).toBe("updated");
      const rendered = readFileSync(instructionFilePath(root, "claude"), "utf-8");
      expect(rendered).toContain("EDITED ROLE");
      expect(rendered).not.toContain(CLAUDE_MD_SECTION);
    });

    test("preserves text outside the markers", () => {
      writeFileSync(instructionFilePath(root, "claude"), "# My notes\n\nkeep me\n", "utf-8");
      seedRoleFiles(root);
      writeFileSync(roleFilePath(root, "claude"), "ROLE-A", "utf-8");

      const outcomes = syncRoleSections(root, { agents: ["claude"] });
      expect(outcomes[0].status).toBe("appended");

      const rendered = readFileSync(instructionFilePath(root, "claude"), "utf-8");
      expect(rendered).toContain("keep me");
      expect(rendered).toContain("ROLE-A");
    });

    test("falls back to the built-in default when no role file exists", () => {
      const outcomes = syncRoleSections(root, { agents: ["codex"] });

      expect(outcomes[0].usedDefault).toBe(true);
      expect(readFileSync(instructionFilePath(root, "codex"), "utf-8")).toContain(
        AGENTS_MD_SECTION,
      );
    });

    test("skips a file with malformed markers instead of appending a second block", () => {
      writeFileSync(instructionFilePath(root, "claude"), `notes\n${START}\nstray\n`, "utf-8");
      seedRoleFiles(root);

      const outcomes = syncRoleSections(root, { agents: ["claude"] });
      expect(outcomes[0].status).toBe("skipped");
      expect(outcomes[0].detail).toContain("Malformed");
      expect(readFileSync(instructionFilePath(root, "claude"), "utf-8")).toBe(
        `notes\n${START}\nstray\n`,
      );
    });

    test("dryRun reports drift without writing", () => {
      seedRoleFiles(root);
      syncRoleSections(root);
      writeFileSync(roleFilePath(root, "codex"), "NEW ROLE", "utf-8");
      const before = readFileSync(instructionFilePath(root, "codex"), "utf-8");

      const outcomes = syncRoleSections(root, { dryRun: true, agents: ["codex"] });

      expect(outcomes[0].status).toBe("updated");
      expect(readFileSync(instructionFilePath(root, "codex"), "utf-8")).toBe(before);
    });

    test("agents filter renders only the requested agent", () => {
      seedRoleFiles(root);
      const outcomes = syncRoleSections(root, { agents: ["claude"] });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].agent).toBe("claude");
      expect(() => readFileSync(instructionFilePath(root, "codex"), "utf-8")).toThrow();
    });

    test("a broken role file for one agent does not block the other", () => {
      seedRoleFiles(root);
      writeFileSync(roleFilePath(root, "codex"), "", "utf-8");

      expect(() => syncRoleSections(root, { agents: ["claude"] })).not.toThrow();
      expect(() => syncRoleSections(root, { agents: ["codex"] })).toThrow(RoleFileError);
    });

    test("an unreadable instruction file is skipped, not overwritten", () => {
      seedRoleFiles(root);
      // A directory where CLAUDE.md should be makes readFileSync fail
      // with EISDIR — a stand-in for any non-ENOENT read failure
      // (EACCES, EIO). The old bare catch treated all of them as
      // "file is empty" and wrote the block over the top.
      mkdirSync(instructionFilePath(root, "claude"), { recursive: true });

      const outcomes = syncRoleSections(root, { agents: ["claude"] });

      expect(outcomes[0].status).toBe("skipped");
      expect(outcomes[0].detail).toContain("cannot read");
    });
  });
});
