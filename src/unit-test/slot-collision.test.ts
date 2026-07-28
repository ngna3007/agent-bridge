import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "../codex-adapter";
import { computeProjectId, computeProjectPorts, findSlotCollisions } from "../project-id";
import { runDoctor } from "../cli/doctor";

/**
 * Two projects whose ids hash to the same port slot used to destroy
 * each other: the second daemon to start found the first one's live
 * `codex app-server` on its port, matched it against a command-line
 * shape test, decided it was its own orphan, and killed it. Both
 * halves of the fix are pinned here — the adapter no longer kills what
 * it cannot prove is its own, and the doctor names the collision
 * before it bites.
 */

describe("findSlotCollisions", () => {
  test("ignores ids that land on other slots", () => {
    // 0x3e8 = 1000, so these two are exactly one slot apart.
    expect(findSlotCollisions("00000000", ["000003e9", "00000001"])).toEqual([]);
  });

  test("finds ids one full slot-cycle away", () => {
    expect(findSlotCollisions("00000000", ["000003e8"])).toEqual(["000003e8"]);
    expect(computeProjectPorts("000003e8").control).toBe(computeProjectPorts("00000000").control);
  });

  test("never reports the project against itself", () => {
    expect(findSlotCollisions("00000000", ["00000000"])).toEqual([]);
  });

  test("reports every colliding id, not just the first", () => {
    expect(findSlotCollisions("00000000", ["000003e8", "000007d0", "00000001"]))
      .toEqual(["000003e8", "000007d0"]);
  });

  test("an empty candidate list is not a collision", () => {
    expect(findSlotCollisions("00000000", [])).toEqual([]);
  });
});

describe("CodexAdapter.classifyPortHolder", () => {
  const CMD = "codex app-server --listen ws://127.0.0.1:14500";

  test("claims a codex app-server whose pid we recorded", () => {
    expect(CodexAdapter.classifyPortHolder(4242, CMD, 4242)).toBe("ours");
  });

  test("refuses to claim an identical command line at a different pid", () => {
    // This is the whole bug. On a slot collision the other project's
    // app-server has a byte-identical command line, including the port,
    // so only the pid can tell the two apart.
    expect(CodexAdapter.classifyPortHolder(9999, CMD, 4242)).toBe("foreign-codex");
  });

  test("refuses to claim anything when nothing was recorded", () => {
    // No record means we have never successfully spawned one, so
    // whatever is on the port belongs to someone else.
    expect(CodexAdapter.classifyPortHolder(4242, CMD, null)).toBe("foreign-codex");
  });

  test("separates a non-codex process from a codex one", () => {
    expect(CodexAdapter.classifyPortHolder(4242, "python -m http.server 14500", 4242)).toBe("foreign");
    expect(CodexAdapter.classifyPortHolder(4242, "codex --enable tui_app_server", 4242)).toBe("foreign");
  });
});

describe("abg doctor - slot collision", () => {
  let tmp: string;
  let projectRoot: string;
  let platformRoot: string;
  let savedCwd: () => string;
  let savedEnv: Record<string, string | undefined>;
  let savedLog: typeof console.log;
  let logBuf: string[];

  const DEAD_PID = 2_147_483_600;

  /** An 8-hex id that lands on the same slot as `id`. */
  function collidingId(id: string): string {
    const value = parseInt(id, 16);
    const shifted = value >= 1000 ? value - 1000 : value + 1000;
    return shifted.toString(16).padStart(8, "0");
  }

  /** Create a sibling state dir that `enumerateStateDirs` will find. */
  function seedProject(id: string, pid: number | null): void {
    const dir = join(platformRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agentbridge.log"), "");
    if (pid !== null) writeFileSync(join(dir, "daemon.pid"), `${pid}\n`);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "abg-slot-"));
    projectRoot = join(tmp, "project");
    mkdirSync(projectRoot);
    mkdirSync(join(projectRoot, ".agentbridge"));

    savedEnv = {
      AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
      AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
      CODEX_WS_PORT: process.env.CODEX_WS_PORT,
      CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      HOME: process.env.HOME,
    };
    for (const k of Object.keys(savedEnv)) delete process.env[k];
    process.env.XDG_STATE_HOME = tmp;
    process.env.HOME = tmp;

    platformRoot = join(tmp, "agentbridge");
    mkdirSync(platformRoot);
    mkdirSync(join(platformRoot, computeProjectId(projectRoot)));

    savedCwd = process.cwd;
    process.cwd = () => projectRoot;

    savedLog = console.log;
    logBuf = [];
    console.log = (msg?: any) => {
      logBuf.push(typeof msg === "string" ? msg : String(msg));
    };
  });

  afterEach(() => {
    console.log = savedLog;
    process.cwd = savedCwd;
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const output = () => logBuf.join("\n");

  test("says nothing when this project is the only one", async () => {
    await runDoctor();
    expect(output()).not.toContain("slot collision");
  });

  test("ignores projects on other slots", async () => {
    // One away in id space is one away in slot space, so this project
    // is a near-miss rather than a collision.
    const self = computeProjectId(projectRoot);
    const neighbour = (parseInt(self, 16) - 1).toString(16).padStart(8, "0");
    seedProject(neighbour, DEAD_PID);

    await runDoctor();

    expect(output()).not.toContain("slot collision");
  });

  test("names a colliding project even when its daemon is not running", async () => {
    const other = collidingId(computeProjectId(projectRoot));
    seedProject(other, null);

    await runDoctor();

    expect(output()).toContain("Port slot collision");
    expect(output()).toContain(other);
  });

  test("escalates to an error when the colliding daemon is live", async () => {
    // A dead collision is a latent problem; a live one means the next
    // launch is about to contend for a port that is already held.
    const other = collidingId(computeProjectId(projectRoot));
    seedProject(other, process.pid);

    await runDoctor();

    expect(output()).toContain("currently running");
    expect(output()).toContain("[ERROR] Port slot collision");
  });

  test("does not count a colliding project whose daemon.pid is stale as running", async () => {
    const other = collidingId(computeProjectId(projectRoot));
    seedProject(other, DEAD_PID);

    await runDoctor();

    expect(output()).toContain("[WARN ] Port slot collision");
    expect(output()).not.toContain("currently running");
  });

  test("never offers to auto-repair a collision", async () => {
    // Resolving one means moving a project or pinning its ports. The
    // doctor cannot pick which project loses.
    const other = collidingId(computeProjectId(projectRoot));
    seedProject(other, null);

    await runDoctor(["--fix"]);

    expect(output()).toContain("Port slot collision");
    expect(output()).not.toMatch(/repaired.*collision/i);
  });

  test("skips directories that are not project state dirs", async () => {
    // `enumerateStateDirs` also returns the platform root itself and
    // any legacy single-instance dir; neither has an 8-hex id and
    // neither can collide with anything.
    writeFileSync(join(platformRoot, "agentbridge.log"), "");
    mkdirSync(join(platformRoot, "not-a-project-id"));
    writeFileSync(join(platformRoot, "not-a-project-id", "daemon.pid"), `${DEAD_PID}\n`);

    await runDoctor();

    expect(output()).not.toContain("slot collision");
  });
});
