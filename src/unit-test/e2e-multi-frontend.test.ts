import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_PROJECT_MISMATCH,
  CLOSE_CODE_UNKNOWN_AGENT,
} from "../control-protocol";
import type { DaemonStatus } from "../control-protocol";

/**
 * E2E: one frontend slot per agent, against a real daemon.
 *
 * The unit tests in `frontend-registry.test.ts` prove the bookkeeping.
 * This proves the wire: that the `agent` field survives `claude_connect`,
 * that an absent field still means Claude, that same-agent contention
 * behaves exactly as it did when there was one slot, and that a name the
 * daemon does not recognize is refused rather than handed Claude's slot.
 *
 * Claude is the only frontend agent today — Grok moved behind the leader
 * proxy and Codex was always behind its own — so the two-agent cases now
 * live in `frontend-registry.test.ts`, where the registry's agent type is
 * a test-local union. What survives here is what the wire can still do.
 *
 * Ports are deliberately distinct from `e2e-reconnect.test.ts` so the two
 * files cannot collide if they ever run concurrently.
 */

const TEST_CONTROL_PORT = 15552;
const TEST_APP_PORT = 15550;
const TEST_PROXY_PORT = 15551;
const TEST_STATE_DIR = `/tmp/agentbridge-e2e-multi-${TEST_CONTROL_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${TEST_CONTROL_PORT}/healthz`;
const WS_URL = `ws://127.0.0.1:${TEST_CONTROL_PORT}/ws`;
const DAEMON_PATH = fileURLToPath(new URL("../daemon.ts", import.meta.url));

/**
 * Per-test budget.
 *
 * Bun's 5 s default is the same order as `LIVENESS_PROBE_TIMEOUT_MS`, so a
 * contest test that waits for a probe to conclude can outlive it and report
 * whatever close code the teardown produced instead of the daemon's.
 */
const TEST_TIMEOUT_MS = 20_000;

let daemonProc: ChildProcess | null = null;
const openSockets: WebSocket[] = [];

function launchDaemon(): ChildProcess {
  mkdirSync(TEST_STATE_DIR, { recursive: true });
  return spawn(process.execPath, ["run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(TEST_CONTROL_PORT),
      AGENTBRIDGE_STATE_DIR: TEST_STATE_DIR,
      CODEX_WS_PORT: String(TEST_APP_PORT),
      CODEX_PROXY_PORT: String(TEST_PROXY_PORT),
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
      AGENTBRIDGE_PROJECT_ID: "",
    },
    stdio: "pipe",
  });
}

async function waitForHealth(maxRetries = 40, delayMs = 250): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if ((await fetch(HEALTH_URL)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function status(): Promise<DaemonStatus> {
  return (await fetch(HEALTH_URL)).json() as Promise<DaemonStatus>;
}

/** Poll /healthz until `pred` holds, so tests never race the async attach path. */
async function waitForStatus(
  pred: (s: DaemonStatus) => boolean,
  timeoutMs = 3000,
): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  let last = await status();
  while (Date.now() < deadline) {
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
    last = await status();
  }
  return last;
}

/** A control socket that reports its own close code, which is the whole assertion in a contest. */
interface Frontend {
  ws: WebSocket;
  closed: Promise<number>;
}

async function openFrontend(): Promise<Frontend> {
  const ws = new WebSocket(WS_URL);
  openSockets.push(ws);
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve((event as CloseEvent).code));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("control socket failed to open")));
  });
  return { ws, closed };
}

/**
 * Send `claude_connect`. `agent` is passed through untouched — including
 * the absent case, which every pre-0.8 frontend sends and which has to
 * keep meaning Claude.
 */
function attach(frontend: Frontend, agent?: unknown) {
  frontend.ws.send(
    JSON.stringify(agent === undefined ? { type: "claude_connect" } : { type: "claude_connect", agent }),
  );
}

/** Resolve to the close code, or null if the socket is still open after `ms`. */
function closeCodeWithin(frontend: Frontend, ms: number): Promise<number | null> {
  return Promise.race([
    frontend.closed,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

describe("E2E: one frontend slot per agent", () => {
  beforeAll(async () => {
    daemonProc = launchDaemon();
    if (!(await waitForHealth())) throw new Error("daemon never became healthy");

    // Ports hash into 1000 slots, and a dev machine can already be
    // holding this one. Answering /healthz is not enough — the daemon
    // that answered has to be the one this file started, or every
    // assertion below is about someone else's state.
    const answered = await status();
    if (answered.pid !== daemonProc.pid) {
      throw new Error(
        `port ${TEST_CONTROL_PORT} is held by pid ${answered.pid}, not the daemon this test started ` +
          `(${daemonProc.pid}) — stop it, or move this file's ports.`,
      );
    }
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      try { ws.close(); } catch {}
    }
    if (daemonProc && daemonProc.exitCode === null) {
      const exited = new Promise<void>((r) => daemonProc!.once("exit", () => r()));
      daemonProc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (daemonProc.exitCode === null) daemonProc.kill("SIGKILL");
    }
    try { rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch {}
  });

  test("a frontend that declares no agent is still Claude", async () => {
    const claude = await openFrontend();
    attach(claude);

    const s = await waitForStatus((x) => x.claudeAttached);
    expect(s.claudeAttached).toBe(true);
    expect(s.attachedAgents).toEqual(["claude"]);

    claude.ws.close();
    await waitForStatus((x) => x.attachedAgents.length === 0);
  }, TEST_TIMEOUT_MS);

  test("a second frontend for the same agent still loses to a live incumbent", async () => {
    const first = await openFrontend();
    attach(first, "claude");
    await waitForStatus((x) => x.attachedAgents.includes("claude"));

    const second = await openFrontend();
    attach(second, "claude");

    // The incumbent answers the liveness probe (Bun's WebSocket pongs at
    // the protocol level), so the contestant is refused — unchanged from
    // single-slot behavior, now scoped to one agent.
    expect(await closeCodeWithin(second, 5000)).toBe(CLOSE_CODE_REPLACED);

    const s = await status();
    expect(s.attachedAgents).toEqual(["claude"]);
    expect(s.claudeAttached).toBe(true);

    first.ws.close();
    await waitForStatus((x) => x.attachedAgents.length === 0);
  }, TEST_TIMEOUT_MS);

  test("an unknown agent is refused rather than given Claude's slot", async () => {
    const stranger = await openFrontend();
    attach(stranger, "codex");

    expect(await closeCodeWithin(stranger, 2000)).toBe(CLOSE_CODE_UNKNOWN_AGENT);
    expect((await status()).attachedAgents).toEqual([]);

    // Grok is the case with history: it *was* a frontend, so a stale
    // build or a hand-set AGENTBRIDGE_AGENT can still send this. It is
    // proxied now, and a slot is not what it should get.
    const grok = await openFrontend();
    attach(grok, "grok");

    expect(await closeCodeWithin(grok, 2000)).toBe(CLOSE_CODE_UNKNOWN_AGENT);
    expect((await status()).attachedAgents).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("a foreign project is refused with a code distinct from the unknown-agent one", async () => {
    // The two refusals want opposite recoveries — a port collision is fixed by
    // `abg doctor --fix`, an unrecognized agent by restarting the daemon — so
    // the frontend can only tell the user which one it is if the codes differ.
    // Asserting the values apart is what stops them silently collapsing again.
    expect(CLOSE_CODE_PROJECT_MISMATCH).not.toBe(CLOSE_CODE_UNKNOWN_AGENT);

    const foreign = await openFrontend();
    foreign.ws.send(
      JSON.stringify({ type: "claude_connect", projectId: "deadbeef", agent: "claude" }),
    );

    expect(await closeCodeWithin(foreign, 2000)).toBe(CLOSE_CODE_PROJECT_MISMATCH);
    expect((await status()).attachedAgents).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
