#!/usr/bin/env bun
/**
 * Tier 2b — the reply outbox, end to end, against a real daemon.
 *
 * Why this file exists
 * -------------------
 * `src/reply-outbox.ts` is well covered as a data structure, and none
 * of that says the daemon uses it correctly. The wiring — accept on a
 * mid-turn refusal, drain one on `turn/completed`, requeue when a new
 * turn beat the drain, notice on expiry, discard when Codex dies — has
 * six call sites in daemon.ts and had no test that ran any of them.
 * That matters more than usual here because the role text now tells
 * Claude a queued reply must NOT be resent: if the drain silently
 * fails, the message is gone and nothing retries it.
 *
 * Unlike `tier2-bridge-e2e.ts` this does not spend model tokens. The
 * app-server is `fake-codex-app-server.ts`, reached by putting
 * `fake-codex-bin/` first on PATH, which lets the test hold a turn open
 * for a known duration instead of racing a model. Everything above the
 * app-server is production code: daemon.ts, CodexAdapter, the control
 * WebSocket, and the real control protocol.
 *
 * Run: bun run test:live:outbox
 */

import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import type { ControlServerMessage } from "../control-protocol";

const REPO = resolve(import.meta.dir, "../..");
const SHIM_BIN = join(REPO, "src/live-test/fake-codex-bin");
const LAB = join(tmpdir(), "agentbridge-outbox-lab");

// Well clear of both the 14500+ project range and tier2's 17801+.
const APP_PORT = Number(process.env.OUTBOX_APP_PORT ?? 17821);
const PROXY_PORT = Number(process.env.OUTBOX_PROXY_PORT ?? 17822);
const CONTROL_PORT = Number(process.env.OUTBOX_CONTROL_PORT ?? 17823);

const HOLD_MS = 6000;
const TURN_MS = 800;

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

/** WSL2 hangs on connect() to a dead loopback port, so the timeout is load-bearing. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve_) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve_(v);
    };
    sock.setTimeout(500);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function waitForPort(port: number, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(200);
  }
  console.error(`  (timed out waiting for ${label} on ${port})`);
  return false;
}

// ── lab ────────────────────────────────────────────────────────

rmSync(LAB, { recursive: true, force: true });
mkdirSync(join(LAB, ".state"), { recursive: true });

const daemonErr: string[] = [];
let daemon: ReturnType<typeof Bun.spawn> | null = null;

function cleanup() {
  try {
    daemon?.kill();
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function bail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  console.error("--- daemon stderr (tail) ---");
  console.error(daemonErr.slice(-40).join(""));
  cleanup();
  process.exit(1);
}

async function drainInto(stream: ReadableStream<Uint8Array>, sink: string[]) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    sink.push(dec.decode(value));
  }
}

// ── T2b.1 daemon boots against the fake app-server ─────────────

console.log("== T2b.1 daemon boots with a deterministic app-server ==");

daemon = Bun.spawn(["bun", "run", join(REPO, "src/daemon.ts")], {
  env: {
    ...process.env,
    PATH: `${SHIM_BIN}:${process.env.PATH}`,
    CODEX_WS_PORT: String(APP_PORT),
    CODEX_PROXY_PORT: String(PROXY_PORT),
    AGENTBRIDGE_CONTROL_PORT: String(CONTROL_PORT),
    AGENTBRIDGE_STATE_DIR: join(LAB, ".state"),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "600000",
    // Small and short so the overflow and expiry paths are reachable
    // inside a test run rather than only in principle.
    AGENTBRIDGE_REPLY_QUEUE_MAX: "2",
    AGENTBRIDGE_REPLY_QUEUE_TTL_MS: "60000",
    FAKE_TURN_MS: String(TURN_MS),
    FAKE_HOLD_MS: String(HOLD_MS),
  },
  cwd: LAB,
  stdout: "pipe",
  stderr: "pipe",
});
void drainInto(daemon.stdout as ReadableStream<Uint8Array>, daemonErr);
void drainInto(daemon.stderr as ReadableStream<Uint8Array>, daemonErr);

check("fake app-server listening", await waitForPort(APP_PORT, "fake app-server"));
check("adapter proxy listening", await waitForPort(PROXY_PORT, "adapter proxy"));
check("control server listening", await waitForPort(CONTROL_PORT, "control server"));
if (fail > 0) bail("Daemon did not come up.");

// ── T2b.2 fake TUI handshake ───────────────────────────────────

console.log("\n== T2b.2 fake TUI attaches and creates a thread ==");

const tui = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
const tuiPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let tuiNextId = 1;

await new Promise<void>((res, rej) => {
  tui.addEventListener("open", () => res(), { once: true });
  tui.addEventListener("error", () => rej(new Error("TUI socket error")), { once: true });
  setTimeout(() => rej(new Error("TUI connect timed out")), 10_000);
}).catch((err) => {
  check("fake TUI connected to the proxy", false, err.message);
  bail("Could not attach the fake TUI.");
});

tui.addEventListener("message", (ev) => {
  let msg: any;
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = tuiPending.get(msg.id);
    if (!p) return;
    tuiPending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

function tuiRequest(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  const id = tuiNextId++;
  return new Promise((res, rej) => {
    tuiPending.set(id, { resolve: res, reject: rej });
    tui.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (tuiPending.delete(id)) rej(new Error(`${method} timed out`));
    }, timeoutMs);
  });
}

let threadId = "";
try {
  await tuiRequest("initialize", { clientInfo: { name: "outbox-harness", version: "0.0.1" } });
  tui.send(JSON.stringify({ method: "initialized", params: {} }));
  const started = await tuiRequest("thread/start", { cwd: LAB });
  threadId = started?.thread?.id ?? "";
} catch (err: any) {
  check("TUI handshake completed", false, err.message);
}
check("thread/start returned a thread id", threadId.length > 0, threadId);
if (!threadId) bail("No thread id — nothing can be injected.");
await sleep(500);

// ── control client (stands in for bridge.ts) ───────────────────

const control = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}/ws`);
const fromDaemon: ControlServerMessage[] = [];
const replyResults = new Map<string, any>();

await new Promise<void>((res, rej) => {
  control.addEventListener("open", () => res(), { once: true });
  setTimeout(() => rej(new Error("control connect timed out")), 10_000);
}).catch((err) => bail(err.message));

control.addEventListener("message", (ev) => {
  let msg: ControlServerMessage;
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  fromDaemon.push(msg);
  if (msg.type === "claude_to_codex_result") replyResults.set(msg.requestId, msg);
});
control.send(JSON.stringify({ type: "claude_connect" }));
await sleep(300);

function sendReply(requestId: string, content: string, requireReply = false) {
  control.send(JSON.stringify({
    type: "claude_to_codex",
    requestId,
    requireReply,
    message: { id: `msg_${requestId}`, source: "claude", content, timestamp: Date.now() },
  }));
}

async function waitFor<T>(what: string, probe: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await sleep(100);
  }
  console.error(`  (timed out waiting for ${what})`);
  return null;
}

const codexTexts = () =>
  fromDaemon.filter((m) => m.type === "codex_to_claude").map((m: any) => String(m.message.content));

/**
 * Open a turn from the TUI side and prove it is actually running.
 *
 * `claude_connect` makes the daemon inject its own kickoff turn, so a
 * turn/start fired straight afterwards is refused by the app-server
 * and the "mid-turn" window the test needs never exists. Awaiting the
 * response — and failing loudly on an error — is what keeps a racing
 * harness from being mistaken for a working outbox.
 */
async function startHoldTurn(label: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await tuiRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: `@@HOLD@@ ${label}` }],
      });
      if (res?.turn?.id) {
        check(`hold turn open (${label})`, true);
        return true;
      }
    } catch (err: any) {
      // "a turn is already running" — the kickoff turn has not finished.
      if (Date.now() > deadline) {
        check(`hold turn open (${label})`, false, err.message);
        return false;
      }
      await sleep(250);
      continue;
    }
    if (Date.now() > deadline) {
      check(`hold turn open (${label})`, false, "no turn id in response");
      return false;
    }
  }
}

// ── T2b.3 a reply sent mid-turn is queued, not refused ─────────

console.log("\n== T2b.3 reply during an open turn is accepted and held ==");

// The TUI starts a turn that will stay open for HOLD_MS.
if (!(await startHoldTurn("long running turn"))) bail("Could not open a turn to reply into.");
await sleep(300);

const NONCE = "OUTBOX-NONCE-7731";
sendReply("r1", `[REPLY] ${NONCE} queued while busy`);

const r1 = await waitFor("the queued reply result", () => replyResults.get("r1"), 8000);
check("daemon answered the mid-turn reply", !!r1);
check("mid-turn reply was accepted, not failed", r1?.success === true, JSON.stringify(r1));
check("result is flagged queued", r1?.queued === true, JSON.stringify(r1));
check(
  "note explains the hold",
  typeof r1?.note === "string" && /mid-turn/i.test(r1.note),
  String(r1?.note),
);

// ── T2b.4 the held reply is injected when the turn ends ────────

console.log("\n== T2b.4 the held reply is delivered after the turn completes ==");

const echoed = await waitFor(
  "the queued reply to reach Codex and echo back",
  () => codexTexts().some((t) => t.includes(NONCE)),
  HOLD_MS + 10_000,
);
check("queued reply reached Codex after the turn ended", echoed === true, codexTexts().join(" | ").slice(0, 300));

const deliveredNotice = fromDaemon.some(
  (m: any) => m.type === "codex_to_claude" && String(m.message.id).startsWith("notice_") &&
    /has now been delivered/.test(String(m.message.content)),
);
check("Claude was told the held reply went out", deliveredNotice);

// ── T2b.5 two held replies keep their order ────────────────────

console.log("\n== T2b.5 two held replies are delivered oldest first ==");

if (!(await startHoldTurn("second long turn"))) bail("Could not open a second turn.");
await sleep(300);

const before = codexTexts().length;
sendReply("r2", "[REPLY] ORDER-FIRST");
await sleep(200);
sendReply("r3", "[REPLY] ORDER-SECOND");

const q2 = await waitFor("second queue ack", () => replyResults.get("r2"), 8000);
const q3 = await waitFor("third queue ack", () => replyResults.get("r3"), 8000);
check("both replies were queued", q2?.queued === true && q3?.queued === true, JSON.stringify([q2?.queued, q3?.queued]));
check("the second ack reports a deeper queue", /2 replies now queued/.test(String(q3?.note)), String(q3?.note));

const bothLanded = await waitFor(
  "both held replies to reach Codex",
  () => {
    const after = codexTexts().slice(before);
    return after.some((t) => t.includes("ORDER-FIRST")) && after.some((t) => t.includes("ORDER-SECOND"));
  },
  HOLD_MS + 20_000,
);
check("both held replies were delivered", bothLanded === true, codexTexts().slice(before).join(" | ").slice(0, 300));

if (bothLanded) {
  const after = codexTexts().slice(before);
  const iFirst = after.findIndex((t) => t.includes("ORDER-FIRST"));
  const iSecond = after.findIndex((t) => t.includes("ORDER-SECOND"));
  check("oldest queued reply was delivered first", iFirst < iSecond, `first@${iFirst} second@${iSecond}`);
}

// ── T2b.6 losing Codex reports what was held ───────────────────

console.log("\n== T2b.6 a held reply is reported, not lost, when Codex dies ==");

if (!(await startHoldTurn("turn that will be killed"))) bail("Could not open a turn to kill.");
await sleep(300);
sendReply("r4", "[REPLY] DOOMED-MESSAGE");
const q4 = await waitFor("fourth queue ack", () => replyResults.get("r4"), 8000);
check("reply queued before the kill", q4?.queued === true, JSON.stringify(q4));

// Kill the app-server out from under the daemon. `pkill -f` would also
// match this harness's own command line, so target the port's holder.
const holder = await Bun.$`ss -lptnH sport = :${APP_PORT}`.text().catch(() => "");
const pidMatch = holder.match(/pid=(\d+)/);
if (pidMatch) {
  process.kill(Number(pidMatch[1]), "SIGKILL");
} else {
  check("found the fake app-server pid", false, holder.slice(0, 120));
}

const lossNotice = await waitFor(
  "the undelivered-message notice",
  () =>
    fromDaemon.some(
      (m: any) =>
        m.type === "codex_to_claude" &&
        /DOOMED-MESSAGE/.test(String(m.message.content)) &&
        /(never delivered|could not be delivered|never saw it)/i.test(String(m.message.content)),
    ),
  20_000,
);
if (!lossNotice) {
  console.error("--- daemon log after the kill ---");
  console.error(daemonErr.join("").split("\n").slice(-25).join("\n"));
}
check("Claude was told the held reply was lost, with the text echoed back", lossNotice === true,
  fromDaemon.filter((m: any) => m.type === "codex_to_claude").map((m: any) => String(m.message.content).slice(0, 80)).join(" | ").slice(0, 400));

// ── done ───────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
