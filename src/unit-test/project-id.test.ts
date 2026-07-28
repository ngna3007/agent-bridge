import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  computeProjectId,
  computeProjectPorts,
  resolveProject,
  applyProjectEnv,
  checkSetupLocation,
} from "../project-id";

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-proj-"));
  savedEnv = {
    AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
    CODEX_WS_PORT: process.env.CODEX_WS_PORT,
    CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
    AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
    AGENTBRIDGE_PROJECT_ID: process.env.AGENTBRIDGE_PROJECT_ID,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("findProjectRoot", () => {
  test("returns null when no .agentbridge marker exists upward", () => {
    expect(findProjectRoot(tmp)).toBeNull();
  });

  test("finds the directory that directly contains .agentbridge/", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    expect(findProjectRoot(tmp)).toBe(tmp);
  });

  test("walks upward from a deep cwd to the nearest .agentbridge ancestor", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const deep = join(tmp, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findProjectRoot(deep)).toBe(tmp);
  });

  test("picks the closest ancestor when multiple markers exist on the path", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const inner = join(tmp, "inner");
    mkdirSync(inner);
    mkdirSync(join(inner, ".agentbridge"));
    const cwd = join(inner, "deep");
    mkdirSync(cwd);
    expect(findProjectRoot(cwd)).toBe(inner);
  });
});

describe("computeProjectId", () => {
  test("returns 8 hex characters", () => {
    const id = computeProjectId("/some/project");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("is deterministic for the same path", () => {
    expect(computeProjectId("/a/b/c")).toBe(computeProjectId("/a/b/c"));
  });

  test("changes when the path changes", () => {
    expect(computeProjectId("/a/b/c")).not.toBe(computeProjectId("/a/b/d"));
  });

  test("normalizes the path before hashing", () => {
    // Trailing slash and "." segments should not change the ID.
    expect(computeProjectId("/a/b/c")).toBe(computeProjectId("/a/b/c/"));
    expect(computeProjectId("/a/b/c")).toBe(computeProjectId("/a/b/./c"));
  });
});

describe("computeProjectPorts", () => {
  test("returns three sequential ports in the per-project range", () => {
    const ports = computeProjectPorts("00000000");
    expect(ports.codexWs).toBe(14500);
    expect(ports.codexProxy).toBe(14501);
    expect(ports.control).toBe(14502);
  });

  test("ports fall inside 14500-17499 for any project id", () => {
    const samples = ["00000000", "deadbeef", "ffffffff", "12345678"];
    for (const id of samples) {
      const p = computeProjectPorts(id);
      expect(p.codexWs).toBeGreaterThanOrEqual(14500);
      expect(p.control).toBeLessThan(17500);
      expect(p.codexProxy).toBe(p.codexWs + 1);
      expect(p.control).toBe(p.codexWs + 2);
    }
  });

  test("two distinct ids almost always produce distinct port triples", () => {
    const a = computeProjectPorts("aaaaaaaa");
    const b = computeProjectPorts("bbbbbbbb");
    expect(a.codexWs).not.toBe(b.codexWs);
  });
});

describe("resolveProject", () => {
  test("returns null when cwd has no .agentbridge ancestor", () => {
    expect(resolveProject(tmp)).toBeNull();
  });

  test("returns full info when the marker exists", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const info = resolveProject(tmp);
    expect(info).not.toBeNull();
    expect(info!.rootPath).toBe(tmp);
    expect(info!.projectId).toMatch(/^[0-9a-f]{8}$/);
    expect(info!.ports.codexProxy).toBe(info!.ports.codexWs + 1);
  });
});

describe("applyProjectEnv", () => {
  test("sets all four namespacing env vars when none are present", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const proj = resolveProject(tmp)!;
    applyProjectEnv(proj, "/state");
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBe(String(proj.ports.control));
    expect(process.env.CODEX_WS_PORT).toBe(String(proj.ports.codexWs));
    expect(process.env.CODEX_PROXY_PORT).toBe(String(proj.ports.codexProxy));
    expect(process.env.AGENTBRIDGE_STATE_DIR).toBe(`/state/${proj.projectId}`);
    expect(process.env.AGENTBRIDGE_PROJECT_ID).toBe(proj.projectId);
  });

  test("never overrides an env var the user explicitly set", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const proj = resolveProject(tmp)!;
    process.env.AGENTBRIDGE_CONTROL_PORT = "9999";
    process.env.AGENTBRIDGE_STATE_DIR = "/custom/state";
    applyProjectEnv(proj, "/state");
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBe("9999");
    expect(process.env.AGENTBRIDGE_STATE_DIR).toBe("/custom/state");
    // The unset ones should still get the project defaults.
    expect(process.env.CODEX_WS_PORT).toBe(String(proj.ports.codexWs));
  });

  test("is idempotent", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const proj = resolveProject(tmp)!;
    applyProjectEnv(proj, "/state");
    const snapshot = {
      ctrl: process.env.AGENTBRIDGE_CONTROL_PORT,
      ws: process.env.CODEX_WS_PORT,
      proxy: process.env.CODEX_PROXY_PORT,
      state: process.env.AGENTBRIDGE_STATE_DIR,
    };
    applyProjectEnv(proj, "/state");
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBe(snapshot.ctrl!);
    expect(process.env.AGENTBRIDGE_STATE_DIR).toBe(snapshot.state!);
  });
});

describe("checkSetupLocation", () => {
  const HOME = "/home/someone";

  test("allows a normal project directory", () => {
    expect(checkSetupLocation(tmp, HOME)).toBe(null);
  });

  test("refuses the home directory itself", () => {
    expect(checkSetupLocation(HOME, HOME)).toEqual({ kind: "unsafe-root", dir: HOME });
  });

  test("refuses the parent of home", () => {
    expect(checkSetupLocation("/home", HOME)).toEqual({ kind: "unsafe-root", dir: "/home" });
  });

  test("refuses the filesystem root", () => {
    expect(checkSetupLocation("/", HOME)).toEqual({ kind: "unsafe-root", dir: "/" });
  });

  test("allows a directory inside home", () => {
    expect(checkSetupLocation(tmp, HOME)).toBe(null);
  });

  test("refuses nesting inside an existing project", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    const child = join(tmp, "packages", "web");
    mkdirSync(child, { recursive: true });
    expect(checkSetupLocation(child, HOME)).toEqual({
      kind: "nested",
      dir: child,
      existingRoot: tmp,
    });
  });

  // Re-initing the project's own root is legal - that is how `abg init`
  // refreshes an existing project.
  test("allows re-init at an existing project's own root", () => {
    mkdirSync(join(tmp, ".agentbridge"));
    expect(checkSetupLocation(tmp, HOME)).toBe(null);
  });

  test("normalizes a trailing slash before comparing", () => {
    expect(checkSetupLocation(`${HOME}/`, HOME)).toEqual({ kind: "unsafe-root", dir: HOME });
  });
});
