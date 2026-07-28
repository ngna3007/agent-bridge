#!/usr/bin/env bun
/**
 * Tier 2c — a real port-slot collision between two real projects.
 *
 * The unit tests cover `classifyPortHolder` and `findSlotCollisions` as
 * pure functions. Neither says what happens when two daemons actually
 * derive the same ports: the bug being guarded against is a *live*
 * daemon killing another project's `codex app-server` and taking the
 * port, and the only honest way to check that is to stand both up.
 *
 * Two halves:
 *   A  two daemons, same port triple, different state dirs. The second
 *      must refuse to start and must leave the first one's app-server
 *      running.
 *   B  two project roots whose ids genuinely collide (found by search,
 *      not by hand-picked hex), and `abg doctor` naming the collision.
 *
 * No model tokens: the app-server is the deterministic fake.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { computeProjectId, computeProjectPorts } from "../project-id";
import { CLOSE_CODE_PROJECT_MISMATCH } from "../control-protocol";

const REPO = resolve(import.meta.dir, "../..");
const SHIM_BIN = join(REPO, "src/live-test/fake-codex-bin");
const LAB = join(tmpdir(), "agentbridge-collision-lab");

const APP_PORT = Number(process.env.COLLIDE_APP_PORT ?? 17841);
const PROXY_PORT = Number(process.env.COLLIDE_PROXY_PORT ?? 17842);
const CONTROL_PORT = Number(process.env.COLLIDE_CONTROL_PORT ?? 17843);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
    fail++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      res(v);
    };
    sock.setTimeout(500);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function waitForPort(port: number, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(200);
  }
  return false;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

rmSync(LAB, { recursive: true, force: true });
mkdirSync(LAB, { recursive: true });

const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
function cleanup() {
  for (const p of spawned) {
    try {
      p.kill();
    } catch {}
  }
}
process.on("exit", cleanup);

// ── A. two daemons, one port triple ────────────────────────────

console.log("== T2c.1 the second daemon on a taken port refuses instead of killing ==");

const stateA = join(LAB, "state-a");
const stateB = join(LAB, "state-b");
mkdirSync(stateA, { recursive: true });
mkdirSync(stateB, { recursive: true });

// The two projects a colliding slot would put on one port triple. The
// ports are forced by env here, so the ids only have to be distinct and
// shaped like real ones — the collision is the premise, not the thing
// under test.
const PROJECT_A_ID = "aaaa1111";
const PROJECT_B_ID = "bbbb2222";

function spawnDaemon(stateDir: string, projectId: string) {
  const proc = Bun.spawn(["bun", "run", join(REPO, "src/daemon.ts")], {
    env: {
      ...process.env,
      PATH: `${SHIM_BIN}:${process.env.PATH}`,
      CODEX_WS_PORT: String(APP_PORT),
      CODEX_PROXY_PORT: String(PROXY_PORT),
      AGENTBRIDGE_CONTROL_PORT: String(CONTROL_PORT),
      AGENTBRIDGE_PROJECT_ID: projectId,
      AGENTBRIDGE_STATE_DIR: stateDir,
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "600000",
      FAKE_TURN_MS: "300",
    },
    cwd: LAB,
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(proc);
  return proc;
}

const daemonA = spawnDaemon(stateA, PROJECT_A_ID);
check("first daemon's app-server came up", await waitForPort(APP_PORT));

// The pid the first daemon recorded for its own app-server. This is the
// only thing that distinguishes it from an identical process belonging
// to someone else — the command lines are byte-identical by definition.
const pidFileA = join(stateA, "codex-app-server.pid");
check("first daemon recorded its app-server pid", existsSync(pidFileA),
  existsSync(pidFileA) ? "" : "codex-app-server.pid missing");
const appPidA = existsSync(pidFileA) ? Number((await Bun.file(pidFileA).text()).trim()) : 0;
check("recorded pid is a live process", appPidA > 0 && (() => {
  try {
    process.kill(appPidA, 0);
    return true;
  } catch {
    return false;
  }
})(), String(appPidA));

const daemonB = spawnDaemon(stateB, PROJECT_B_ID);
const exitB = await daemonB.exited;
const errB = await readAll(daemonB.stderr as ReadableStream<Uint8Array>);
const outB = await readAll(daemonB.stdout as ReadableStream<Uint8Array>);
const logB = `${outB}\n${errB}`;

const namedTheCollision =
  /already held by/.test(logB) && /doctor/.test(logB) && logB.includes(PROJECT_A_ID);
if (exitB === 0 || !namedTheCollision) {
  console.error("--- second daemon output ---");
  console.error(logB.trim().split("\n").slice(-20).join("\n"));
  console.error("--- end ---");
}
check("second daemon exited instead of taking the port", exitB !== 0, `exit=${exitB}`);
check(
  "it named the holder and the fix rather than reporting a generic port error",
  namedTheCollision,
  logB.split("\n").filter((l) => /port \d+/i.test(l)).join(" | ").slice(0, 300),
);
check(
  "the failure is a non-zero exit, not a silent success",
  exitB === 1,
  `exit=${exitB}`,
);

// The whole point: the first project's Codex session is untouched.
let firstStillAlive = false;
try {
  process.kill(appPidA, 0);
  firstStillAlive = true;
} catch {}
check("the first project's app-server was NOT killed", firstStillAlive);
check("the first project's app-server is still serving", await portOpen(APP_PORT));

// ── A2. does the second project end up talking to the first? ───

console.log("\n== T2c.1b a colliding project must not attach to the other project's daemon ==");

// `DaemonLifecycle.isHealthy()` is a bare `fetch(/healthz).ok` with no
// identity in it, so a second project whose ports collide can decide
// the daemon it found is its own. If that holds, its Claude is wired
// to the *other* project's Codex — which is worse than the port fight
// this file was written about, because nothing fails.
const { DaemonLifecycle } = await import("../daemon-lifecycle");
const lifecycleB = new DaemonLifecycle({
  controlPort: CONTROL_PORT,
  stateDir: stateB,
  log: () => {},
  projectId: PROJECT_B_ID,
} as any);
const bThinksItIsRunning = await lifecycleB.isHealthy();
check(
  "project B's health probe does not accept project A's daemon",
  bThinksItIsRunning === false,
  bThinksItIsRunning ? "isHealthy() returned true for another project's daemon" : "",
);

// Prove it at the data level: a reply sent by "project B" over the
// shared control port reaches project A's Codex.
//
// Project A needs a TUI and a thread first. Without one the daemon
// refuses every reply for an unrelated reason ("Codex is not ready"),
// and the leak check would pass no matter what — a green tick that
// cannot fail.
const tuiA = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
const pendingA = new Map<number, (v: any) => void>();
let nextA = 1;
await new Promise<void>((res) => {
  tuiA.addEventListener("open", () => res(), { once: true });
  setTimeout(() => res(), 5000);
});
tuiA.addEventListener("message", (ev) => {
  try {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && m.result !== undefined) pendingA.get(m.id)?.(m.result);
  } catch {}
});
function requestA(method: string, params: unknown): Promise<any> {
  const id = nextA++;
  return new Promise((res) => {
    pendingA.set(id, res);
    tuiA.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res(null), 10_000);
  });
}
await requestA("initialize", { clientInfo: { name: "collision-harness", version: "0.0.1" } });
tuiA.send(JSON.stringify({ method: "initialized", params: {} }));
const threadA = (await requestA("thread/start", { cwd: LAB }))?.thread?.id ?? "";
check("project A has a live Codex thread (so the leak check can fail)", threadA.length > 0, threadA);
await sleep(500);
const leakWs = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}/ws`);
let leaked = false;
let closeCode = 0;
await new Promise<void>((res) => {
  leakWs.addEventListener("open", () => res(), { once: true });
  setTimeout(() => res(), 5000);
});
if (leakWs.readyState === WebSocket.OPEN) {
  leakWs.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.type === "claude_to_codex_result" && m.requestId === "leak" && m.success) leaked = true;
    } catch {}
  });
  leakWs.addEventListener("close", (ev) => {
    closeCode = ev.code;
  });
  // A real 0.7 frontend declares its project here. Sending nothing would
  // exercise the deliberately permissive pre-0.7 path instead, and prove
  // nothing about the guard.
  leakWs.send(JSON.stringify({ type: "claude_connect", projectId: PROJECT_B_ID }));
  await sleep(300);
  try {
    leakWs.send(JSON.stringify({
      type: "claude_to_codex",
      requestId: "leak",
      message: { id: "leak", source: "claude", content: "[REPLY] CROSS-PROJECT-LEAK", timestamp: Date.now() },
    }));
  } catch {
    // Already closed on us — which is the correct outcome, not an error.
  }
  await sleep(2000);
}
check(
  "a reply from the colliding project is not accepted by the other project's daemon",
  leaked === false,
  leaked ? "the daemon accepted and forwarded it" : "",
);
check(
  "the daemon closed the foreign frontend with the project-mismatch code",
  closeCode === CLOSE_CODE_PROJECT_MISMATCH,
  `close code ${closeCode}`,
);
try {
  leakWs.close();
} catch {}

daemonA.kill();
await sleep(500);

// ── B. two project roots that genuinely collide ────────────────

console.log("\n== T2c.2 abg doctor names a real colliding project ==");

// Search for two directory names under LAB whose project ids land in
// the same 1000-slot bucket. Hand-picking hex would prove the maths,
// not that real paths can collide.
const projectsRoot = join(LAB, "projects");
mkdirSync(projectsRoot, { recursive: true });
const bySlot = new Map<number, { dir: string; id: string }>();
let pair: [{ dir: string; id: string }, { dir: string; id: string }] | null = null;
for (let i = 0; i < 20_000 && !pair; i++) {
  const dir = join(projectsRoot, `p${i}`);
  const id = computeProjectId(dir);
  const slot = computeProjectPorts(id).control;
  const seen = bySlot.get(slot);
  if (seen) pair = [seen, { dir, id }];
  else bySlot.set(slot, { dir, id });
}
check("found two real paths that derive the same ports", pair !== null,
  pair ? `${pair[0].id} + ${pair[1].id}` : "no collision within 20000 candidates");

if (pair) {
  const [self, other] = pair;
  console.log(`  (collision: ${self.id} and ${other.id} → control ${computeProjectPorts(self.id).control})`);

  // Both projects exist on disk; both have run at least once, which is
  // what leaves a state dir behind for the doctor to enumerate.
  mkdirSync(join(self.dir, ".agentbridge"), { recursive: true });
  mkdirSync(join(other.dir, ".agentbridge"), { recursive: true });

  const xdg = join(LAB, "xdg-state");
  const stateRoot = join(xdg, "agentbridge");
  mkdirSync(join(stateRoot, self.id), { recursive: true });
  mkdirSync(join(stateRoot, other.id), { recursive: true });
  writeFileSync(join(stateRoot, self.id, "agentbridge.log"), "");
  writeFileSync(join(stateRoot, other.id, "agentbridge.log"), "");
  // A stale pid for the other project first: the finding should be a
  // warning when nothing is actually running.
  writeFileSync(join(stateRoot, other.id, "daemon.pid"), "999999");

  const env = { ...process.env, XDG_STATE_HOME: xdg };
  delete (env as Record<string, string | undefined>).AGENTBRIDGE_STATE_DIR;

  const stale = Bun.spawn(["bun", "run", join(REPO, "src/cli.ts"), "doctor"], {
    cwd: self.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(stale);
  await stale.exited;
  const staleOut = `${await readAll(stale.stdout as ReadableStream<Uint8Array>)}${await readAll(stale.stderr as ReadableStream<Uint8Array>)}`;
  check("doctor reports the collision", /Port slot collision/.test(staleOut),
    staleOut.split("\n").filter((l) => /collision|WARN|ERROR/.test(l)).join(" | ").slice(0, 300));
  check("doctor names the colliding project id", staleOut.includes(other.id), other.id);
  check("a stale collision is a warning, not an error",
    /\[WARN \] Port slot collision/.test(staleOut),
    staleOut.split("\n").find((l) => /Port slot collision/.test(l)) ?? "");

  // Now make the other project's daemon look alive. Our own pid is the
  // only one guaranteed to still be there when doctor reads it.
  writeFileSync(join(stateRoot, other.id, "daemon.pid"), String(process.pid));
  const live = Bun.spawn(["bun", "run", join(REPO, "src/cli.ts"), "doctor"], {
    cwd: self.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(live);
  await live.exited;
  const liveOut = `${await readAll(live.stdout as ReadableStream<Uint8Array>)}${await readAll(live.stderr as ReadableStream<Uint8Array>)}`;
  check("a live collision is escalated to an error",
    /\[ERROR\] Port slot collision/.test(liveOut),
    liveOut.split("\n").find((l) => /Port slot collision/.test(l)) ?? "");
  check("the error says which colliding daemon is running",
    /currently running/.test(liveOut),
    liveOut.split("\n").find((l) => /Port slot collision/.test(l)) ?? "");
}

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
