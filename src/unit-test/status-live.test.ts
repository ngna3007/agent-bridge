import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus } from "../cli/status";
import { computeProjectId } from "../project-id";
import type { DaemonStatus } from "../control-protocol";

/**
 * `abg status` used to read only files, which record what was true at
 * daemon boot. The question people open it for — "is the other agent
 * actually there?" — is answerable only by asking the running daemon,
 * so these tests stand up a real /healthz and assert the command uses
 * it, including when it is absent or broken.
 */

let tmp: string;
let projectRoot: string;
let stateDir: string;
let savedCwd: () => string;
let savedEnv: Record<string, string | undefined>;
let savedLog: typeof console.log;
let logBuf: string[];
let server: ReturnType<typeof Bun.serve> | null = null;

const BASE_STATUS: DaemonStatus = {
  bridgeReady: true,
  tuiConnected: true,
  threadId: "thread_abc123",
  queuedMessageCount: 0,
  proxyUrl: "ws://127.0.0.1:17036",
  appServerUrl: "ws://127.0.0.1:17035",
  pid: 4242,
  claudeAttached: true,
  pendingReplyCount: 0,
  projectId: null,
};

/**
 * Serve one /healthz response and point status.json at the port it
 * landed on. Port 0 lets the OS choose, so parallel test files cannot
 * collide.
 */
function serveStatus(status: Partial<DaemonStatus> | null): number {
  const started = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname !== "/healthz") return new Response("nope", { status: 404 });
      if (status === null) return new Response("broken", { status: 500 });
      return Response.json({ ...BASE_STATUS, ...status });
    },
  });
  server = started;
  const port = started.port;
  if (port === undefined) throw new Error("test server did not bind a port");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: port }));
  return port;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abg-status-live-"));
  projectRoot = join(tmp, "project");
  mkdirSync(projectRoot);
  mkdirSync(join(projectRoot, ".agentbridge"));

  savedEnv = {
    AGENTBRIDGE_STATE_DIR: process.env.AGENTBRIDGE_STATE_DIR,
    AGENTBRIDGE_CONTROL_PORT: process.env.AGENTBRIDGE_CONTROL_PORT,
    CODEX_WS_PORT: process.env.CODEX_WS_PORT,
    CODEX_PROXY_PORT: process.env.CODEX_PROXY_PORT,
    AGENTBRIDGE_MODE: process.env.AGENTBRIDGE_MODE,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  process.env.XDG_STATE_HOME = tmp;
  process.env.HOME = tmp;

  const platformRoot = join(tmp, "agentbridge");
  mkdirSync(platformRoot);
  stateDir = join(platformRoot, computeProjectId(projectRoot));
  mkdirSync(stateDir);
  // A live pid is the precondition for asking the daemon anything.
  writeFileSync(join(stateDir, "daemon.pid"), `${process.pid}\n`);

  savedCwd = process.cwd;
  process.cwd = () => projectRoot;

  savedLog = console.log;
  logBuf = [];
  console.log = (msg?: any) => {
    logBuf.push(typeof msg === "string" ? msg : String(msg));
  };
});

afterEach(() => {
  server?.stop(true);
  server = null;
  console.log = savedLog;
  process.cwd = savedCwd;
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const output = () => logBuf.join("\n");

describe("abg status - live daemon view", () => {
  test("reports both sides as attached when they are", async () => {
    serveStatus({});
    await runStatus();

    expect(output()).toContain("claude      attached");
    expect(output()).toContain("codex tui   connected");
    expect(output()).toContain("thread      thread_abc123");
  });

  test("names the missing side and the command that fixes it", async () => {
    serveStatus({ claudeAttached: false });
    await runStatus();

    expect(output()).toContain("claude      not attached");
    expect(output()).toContain("Run `abg claude`");
  });

  test("tells the Codex side to launch when only Claude is attached", async () => {
    serveStatus({ tuiConnected: false });
    await runStatus();

    expect(output()).toContain("codex tui   not connected");
    expect(output()).toContain("Run `abg codex`");
  });

  test("covers the case where nothing is attached at all", async () => {
    serveStatus({ claudeAttached: false, tuiConnected: false });
    await runStatus();

    expect(output()).toContain("Neither side is attached");
  });

  test("explains an attached-but-threadless Codex", async () => {
    // Both processes are up but injection still fails, because
    // CodexAdapter has no threadId until the TUI starts a turn. Without
    // this hint the state looks healthy and behaves broken.
    serveStatus({ threadId: null });
    await runStatus();

    expect(output()).toContain("none yet");
    expect(output()).toContain("Send one message in the Codex TUI");
  });

  test("reports held replies as normal rather than as a problem", async () => {
    serveStatus({ pendingReplyCount: 2 });
    await runStatus();

    expect(output()).toContain("held        2 Claude repl(ies)");
    expect(output()).toContain("no action needed");
  });

  test("reports queued Codex messages", async () => {
    serveStatus({ queuedMessageCount: 3 });
    await runStatus();

    expect(output()).toContain("queued      3 Codex message(s)");
  });

  test("falls back to the file view when the daemon does not answer", async () => {
    // No server: the pid is alive (it is this process) but nothing is
    // listening, which is exactly what a wedged daemon looks like.
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: 1 }));

    await runStatus();

    expect(output()).toContain("did not answer /healthz");
    expect(output()).toContain("abg doctor");
    expect(output()).not.toContain("claude      attached");
  });

  test("treats a non-200 /healthz as no answer rather than parsing it", async () => {
    serveStatus(null);
    await runStatus();

    expect(output()).toContain("did not answer /healthz");
  });

  test("skips the live block entirely when no daemon is running", async () => {
    rmSync(join(stateDir, "daemon.pid"));
    serveStatus({});

    await runStatus();

    expect(output()).toContain("not running");
    expect(output()).not.toContain("Live");
  });

  test("asks the port the daemon actually bound, not the derived one", async () => {
    // status.json records the live port. A config edit or a moved
    // project root can leave the derivation pointing elsewhere, and
    // asking the derived port would report a healthy daemon as dead.
    const port = serveStatus({});
    const ns = await import("../runtime-namespace");
    const derived = ns.resolveRuntimeNamespace({ mutateEnv: false }).project!.ports.control;
    expect(port).not.toBe(derived);

    await runStatus();

    expect(output()).toContain("claude      attached");
  });
});
