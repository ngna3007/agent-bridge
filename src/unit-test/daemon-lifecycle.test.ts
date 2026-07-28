import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle, isProcessAlive } from "../daemon-lifecycle";

describe("DaemonLifecycle", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-lifecycle-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLifecycle(port = 19999) {
    return new DaemonLifecycle({
      stateDir,
      controlPort: port,
      log: (msg) => logs.push(msg),
    });
  }

  test("healthUrl and controlWsUrl use correct port", () => {
    const lc = createLifecycle(5555);
    expect(lc.healthUrl).toBe("http://127.0.0.1:5555/healthz");
    expect(lc.readyUrl).toBe("http://127.0.0.1:5555/readyz");
    expect(lc.controlWsUrl).toBe("ws://127.0.0.1:5555/ws");
  });

  test("readPid returns null when no pid file", () => {
    const lc = createLifecycle();
    expect(lc.readPid()).toBeNull();
  });

  test("writePid and readPid round-trip", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(lc.readPid()).toBe(12345);
  });

  test("removePidFile removes the file", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(existsSync(stateDir.pidFile)).toBe(true);
    lc.removePidFile();
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("removePidFile does not throw when file missing", () => {
    const lc = createLifecycle();
    expect(() => lc.removePidFile()).not.toThrow();
  });

  test("writeStatus and readStatus round-trip", () => {
    const lc = createLifecycle();
    const status = { proxyUrl: "ws://127.0.0.1:4501", controlPort: 4502, pid: 999 };
    lc.writeStatus(status);
    const loaded = lc.readStatus();
    expect(loaded).toEqual(status);
  });

  test("readStatus returns null when no status file", () => {
    const lc = createLifecycle();
    expect(lc.readStatus()).toBeNull();
  });

  test("isHealthy returns false for non-existent port", async () => {
    const lc = createLifecycle(19999);
    expect(await lc.isHealthy()).toBe(false);
  });

  test("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("isProcessAlive returns false for non-existent pid", () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });

  test("kill returns false when no pid file", async () => {
    const lc = createLifecycle();
    const result = await lc.kill();
    expect(result).toBe(false);
  });

  test("kill cleans up stale pid for dead process", async () => {
    const lc = createLifecycle();
    lc.writePid(9999999); // non-existent process
    lc.writeStatus({ pid: 9999999 });

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(existsSync(stateDir.pidFile)).toBe(false);
    expect(existsSync(stateDir.statusFile)).toBe(false);
    expect(logs.some((l) => l.includes("not alive"))).toBe(true);
  });

  test("kill refuses to signal a live process that is not an AgentBridge daemon", async () => {
    const lc = createLifecycle();
    // Use current process pid — it's alive but NOT a daemon
    lc.writePid(process.pid);
    // Don't write matching status (so isDaemonProcess falls through to ps check)

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(logs.some((l) => l.includes("NOT an AgentBridge daemon"))).toBe(true);
    // Pid file should be cleaned up
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("kill proceeds when status.json pid matches", async () => {
    const lc = createLifecycle();
    // Write a non-existent pid but with matching status — tests the isDaemonProcess fast path
    lc.writePid(9999999);
    lc.writeStatus({ pid: 9999999 });

    // Process is dead, so kill returns false before reaching isDaemonProcess
    const result = await lc.kill();
    expect(result).toBe(false);
  });

  describe("identityMatches", () => {
    test("same project id matches", () => {
      expect(DaemonLifecycle.identityMatches("abc12345", "abc12345")).toBe(true);
    });

    test("a different project id does not", () => {
      expect(DaemonLifecycle.identityMatches("abc12345", "def67890")).toBe(false);
    });

    test("no expectation accepts anything, which is single-instance mode", () => {
      expect(DaemonLifecycle.identityMatches(null, "abc12345")).toBe(true);
      expect(DaemonLifecycle.identityMatches(null, null)).toBe(true);
      expect(DaemonLifecycle.identityMatches(null, undefined)).toBe(true);
    });

    test("a daemon that reports no id is accepted, so an upgrade does not orphan it", () => {
      // Pre-0.7 daemons have no projectId in /healthz. Refusing them
      // would strand a running daemon on the first launch after upgrade.
      expect(DaemonLifecycle.identityMatches("abc12345", undefined)).toBe(true);
    });

    test("a daemon outside any project does not serve a project", () => {
      // `null` is reported, not absent: the daemon is new enough to
      // answer, and its answer is "I belong to no project".
      expect(DaemonLifecycle.identityMatches("abc12345", null)).toBe(false);
    });
  });

  describe("isHealthy identity check", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;

    afterEach(() => {
      server?.stop(true);
      server = null;
    });

    /** Stand up a /healthz that answers like a daemon of `projectId`. */
    function serveHealthz(body: Record<string, unknown>): number {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => Response.json(body),
      });
      const port = server.port;
      if (port === undefined) throw new Error("test server did not bind a port");
      return port;
    }

    function lifecycleFor(port: number, projectId: string | null) {
      return new DaemonLifecycle({
        stateDir,
        controlPort: port,
        log: (msg) => logs.push(msg),
        projectId,
      });
    }

    test("healthy when the daemon on the port belongs to this project", async () => {
      const port = serveHealthz({ projectId: "abc12345", proxyUrl: "ws://127.0.0.1:1" });
      expect(await lifecycleFor(port, "abc12345").isHealthy()).toBe(true);
    });

    test("not healthy when another project's daemon holds the port", async () => {
      // The whole point of F2: something answers /healthz, so the old
      // check said yes and this project attached to a foreign Codex.
      const port = serveHealthz({ projectId: "def67890", proxyUrl: "ws://127.0.0.1:1" });
      const lc = lifecycleFor(port, "abc12345");

      expect(await lc.isHealthy()).toBe(false);
      expect(logs.some((l) => l.includes("held by the daemon of project def67890"))).toBe(true);
    });

    test("the foreign-daemon warning is logged once, not once per retry", async () => {
      const port = serveHealthz({ projectId: "def67890", proxyUrl: "ws://127.0.0.1:1" });
      const lc = lifecycleFor(port, "abc12345");

      await lc.isHealthy();
      await lc.isHealthy();
      await lc.isHealthy();

      expect(logs.filter((l) => l.includes("held by the daemon of project")).length).toBe(1);
    });

    test("a daemon without a reported id is still accepted", async () => {
      const port = serveHealthz({ proxyUrl: "ws://127.0.0.1:1" });
      expect(await lifecycleFor(port, "abc12345").isHealthy()).toBe(true);
    });
  });
});
