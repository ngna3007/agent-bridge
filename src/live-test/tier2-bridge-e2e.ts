#!/usr/bin/env bun
/**
 * Tier 2 — full bridge end-to-end, headless.
 *
 * Why this file exists
 * -------------------
 * The Claude→Codex direction used to be untestable without a human at a
 * terminal. `CodexAdapter.injectMessage` refuses to send unless
 * `this.threadId` is set, and the only writers of that field are the
 * `thread/start` / `thread/resume` / `turn/start` response handlers —
 * all of which are fed by the Codex TUI's handshake. No TUI, no thread
 * id, no injection. So the single most important path in the product
 * was covered only by the manual procedure in docs/manual-test-plan.md.
 *
 * This harness supplies the two human-shaped ends and nothing else:
 *
 *   fake TUI     a WebSocket client against the adapter's proxy port
 *                speaking the real app-server handshake (initialize →
 *                initialized → thread/start). The request shapes are
 *                taken from `codex app-server generate-json-schema`,
 *                not reverse-engineered from logs.
 *
 *   fake Claude  an MCP stdio client against the real src/bridge.ts,
 *                calling the real `reply` and `get_messages` tools.
 *
 * Everything in between is production code: bridge.ts → control WS →
 * daemon.ts → CodexAdapter → a real `codex app-server` running a real
 * model turn. Nothing is stubbed, so a pass means the wiring genuinely
 * holds. The assertion is a nonce that only reaches Claude if every
 * link in the chain survived.
 *
 * Cost: this spends real model tokens and takes a few minutes. It is
 * deliberately not part of `bun test src`. Run it with
 * `bun run test:live:bridge`.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";

const REPO = resolve(import.meta.dir, "../..");
const LAB = process.argv[2] ?? join(tmpdir(), "agentbridge-tier2-lab");

// High ports, well clear of the 14500+ project range the CLI derives,
// so a live session on this machine cannot collide with the harness.
const APP_PORT = Number(process.env.TIER2_APP_PORT ?? 17801);
const PROXY_PORT = Number(process.env.TIER2_PROXY_PORT ?? 17802);
const CONTROL_PORT = Number(process.env.TIER2_CONTROL_PORT ?? 17803);

const NONCE = "TIER2-OK-4417";

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

/**
 * WSL2 drops SYN to closed loopback ports instead of answering RST, so
 * a plain connect() to a dead port hangs rather than failing fast. The
 * explicit socket timeout is what makes this usable there.
 */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve_) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve_(v);
    };
    sock.setTimeout(500);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

async function waitForPort(port: number, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(300);
  }
  console.log(`  (timed out waiting for ${label} on :${port})`);
  return false;
}

// ── lab project ────────────────────────────────────────────────

rmSync(LAB, { recursive: true, force: true });
mkdirSync(join(LAB, ".agentbridge/roles"), { recursive: true });
mkdirSync(join(LAB, ".state"), { recursive: true });
writeFileSync(
  join(LAB, ".agentbridge/roles/codex.md"),
  [
    "You are the Codex half of an AgentBridge pair.",
    "",
    "Message routing contract:",
    "- Prefix a message with [REPLY] when it is a direct answer to Claude.",
    "- Prefix with [STATUS] for progress notes.",
    "- Prefix with [FYI] for asides.",
    "",
    "Answer in one short line. Do not use tools.",
  ].join("\n"),
  "utf-8",
);

const env = {
  ...process.env,
  CODEX_WS_PORT: String(APP_PORT),
  CODEX_PROXY_PORT: String(PROXY_PORT),
  AGENTBRIDGE_CONTROL_PORT: String(CONTROL_PORT),
  AGENTBRIDGE_STATE_DIR: join(LAB, ".state"),
  AGENTBRIDGE_FILTER_MODE: "filtered",
  AGENTBRIDGE_MODE: "pull",
  // bridge.ts exits silently without this — the opt-in gate that keeps a
  // stray `claude` session from taking the daemon's single Claude slot.
  AGENTBRIDGE_ACTIVE: "1",
};

const procs: Array<{ kill: (signal?: number | NodeJS.Signals) => void }> = [];
function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function drainToStrings(stream: ReadableStream<Uint8Array>, sink: string[]) {
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream) sink.push(dec.decode(chunk));
    } catch {}
  })();
}

function bail(message: string, daemonErr: string[]): never {
  console.log(`\n${message}`);
  console.log("--- daemon stderr (tail) ---");
  console.log(daemonErr.join("").slice(-3000));
  console.log(`\n======== T2 total: ${pass} passed, ${fail} failed ========`);
  cleanup();
  process.exit(1);
}

// ── T2.1 daemon boot ───────────────────────────────────────────

console.log("== T2.1 daemon boots and starts a real codex app-server ==");
const daemon = Bun.spawn(["bun", "run", join(REPO, "src/daemon.ts")], {
  cwd: LAB,
  env,
  stdout: "ignore",
  stderr: "pipe",
});
procs.push(daemon);
const daemonErr: string[] = [];
drainToStrings(daemon.stderr as ReadableStream<Uint8Array>, daemonErr);

const appUp = await waitForPort(APP_PORT, "codex app-server");
check("codex app-server listening", appUp);
const proxyUp = await waitForPort(PROXY_PORT, "adapter proxy");
check("adapter proxy listening", proxyUp);
const controlUp = await waitForPort(CONTROL_PORT, "control server");
check("control server listening", controlUp);

if (!appUp || !proxyUp || !controlUp) bail("Daemon never came up.", daemonErr);

// ── T2.2 fake TUI handshake ────────────────────────────────────

console.log("\n== T2.2 fake TUI handshake gives the adapter a threadId ==");

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };
const tuiPending = new Map<number, Pending>();
const tuiNotifications: Array<{ method: string }> = [];
let tuiNextId = 1;

const tui = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
try {
  await new Promise<void>((resolve_, reject) => {
    tui.addEventListener("open", () => resolve_());
    tui.addEventListener("error", () => reject(new Error("TUI socket error")));
    setTimeout(() => reject(new Error("TUI connect timeout")), 10_000);
  });
} catch (err: any) {
  check("fake TUI connected to the proxy", false, err.message);
  bail("Could not attach the fake TUI.", daemonErr);
}

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
    return;
  }
  if (msg.method) tuiNotifications.push(msg);
});

function tuiRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
  const id = tuiNextId++;
  return new Promise((resolve_, reject) => {
    tuiPending.set(id, { resolve: resolve_, reject });
    tui.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (tuiPending.delete(id)) reject(new Error(`${method} timed out`));
    }, timeoutMs);
  });
}

let threadId = "";
try {
  const initResult = await tuiRequest("initialize", {
    clientInfo: { name: "agentbridge-tier2-fake-tui", title: "Tier 2 harness", version: "0.0.1" },
  });
  check("app-server accepted initialize", !!initResult);
  tui.send(JSON.stringify({ method: "initialized", params: {} }));

  const started = await tuiRequest(
    "thread/start",
    { cwd: LAB, sandbox: "read-only", approvalPolicy: "never" },
    60_000,
  );
  threadId = started?.thread?.id ?? "";
  check(
    "thread/start returned a thread id",
    threadId.length > 0,
    JSON.stringify(started).slice(0, 200),
  );
} catch (err: any) {
  check("TUI handshake completed", false, err.message);
}

if (!threadId) bail("No thread id — the adapter can never inject.", daemonErr);

// The adapter learns the id by watching that response go past, so give
// the daemon a beat before reading back its own view of the world.
await sleep(1000);
const statusPath = join(LAB, ".state", "status.json");
check(
  "daemon wrote a status file",
  existsSync(statusPath) && readFileSync(statusPath, "utf-8").length > 0,
);

// ── T2.3 fake Claude over MCP stdio ────────────────────────────

console.log("\n== T2.3 real MCP server accepts a client and lists its tools ==");

const mcp = Bun.spawn(["bun", "run", join(REPO, "src/bridge.ts")], {
  cwd: LAB,
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
procs.push(mcp);

const mcpErr: string[] = [];
drainToStrings(mcp.stderr as ReadableStream<Uint8Array>, mcpErr);

const mcpPending = new Map<number, Pending>();
const mcpNotifications: unknown[] = [];
let mcpNextId = 1;

void (async () => {
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of mcp.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk);
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const p = mcpPending.get(msg.id);
          if (!p) continue;
          mcpPending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          mcpNotifications.push(msg);
        }
      }
    }
  } catch {}
})();

function mcpSend(payload: unknown) {
  mcp.stdin.write(JSON.stringify(payload) + "\n");
  mcp.stdin.flush();
}

function mcpRequest(method: string, params?: unknown, timeoutMs = 30_000): Promise<any> {
  const id = mcpNextId++;
  return new Promise((resolve_, reject) => {
    mcpPending.set(id, { resolve: resolve_, reject });
    mcpSend({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (mcpPending.delete(id)) reject(new Error(`${method} timed out`));
    }, timeoutMs);
  });
}

try {
  const init = await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agentbridge-tier2-fake-claude", version: "0.0.1" },
  });
  check("MCP initialize handshake", !!init?.serverInfo, JSON.stringify(init).slice(0, 200));
  mcpSend({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = await mcpRequest("tools/list");
  const toolNames: string[] = (tools?.tools ?? []).map((t: any) => t.name);
  check("reply tool exposed", toolNames.includes("reply"), toolNames.join(","));
  check("get_messages tool exposed", toolNames.includes("get_messages"), toolNames.join(","));
} catch (err: any) {
  check("MCP client connected", false, err.message);
}

// ── T2.4 the daemon's own kickoff turn ─────────────────────────

// Claude connecting makes the daemon inject its "Claude is online"
// notice. That is a real turn; if we do not wait it out, the reply
// below bounces off turnInProgress and the test fails for the wrong
// reason.
console.log("\n== T2.4 daemon's Claude-online kickoff runs as a real Codex turn ==");

async function waitForTurn(label: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawStart = false;
  while (Date.now() < deadline) {
    if (tuiNotifications.some((n) => n.method === "turn/started")) sawStart = true;
    if (sawStart && tuiNotifications.some((n) => n.method === "turn/completed")) return true;
    await sleep(500);
  }
  console.log(`  (timed out waiting for ${label}: sawStart=${sawStart})`);
  return false;
}

check("kickoff turn started and completed", await waitForTurn("kickoff turn", 120_000));
tuiNotifications.length = 0;

// ── T2.5 Claude → Codex through the whole stack ────────────────

console.log("\n== T2.5 reply tool drives a real Codex turn ==");
try {
  const res = await mcpRequest(
    "tools/call",
    {
      name: "reply",
      arguments: {
        text: `Respond with exactly one line: "[REPLY] ${NONCE}". Nothing else.`,
        require_reply: true,
      },
    },
    60_000,
  );
  const replyText = (res?.content ?? []).map((c: any) => c.text ?? "").join(" ");
  check("reply tool reported success", !res?.isError, replyText.slice(0, 200));
  check(
    "injection was not rejected for a missing thread",
    !/no active thread/i.test(replyText),
    replyText.slice(0, 200),
  );
} catch (err: any) {
  check("reply tool call", false, err.message);
}

check("Codex ran a turn for the injected message", await waitForTurn("bridged turn", 120_000));

// ── T2.6 Codex → Claude ────────────────────────────────────────

console.log("\n== T2.6 Codex's [REPLY] comes back to Claude ==");
let drained = "";
const drainDeadline = Date.now() + 60_000;
while (Date.now() < drainDeadline) {
  try {
    const res = await mcpRequest("tools/call", { name: "get_messages", arguments: {} }, 20_000);
    const text = (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
    drained += text + "\n";
    if (text.includes(NONCE)) break;
  } catch {}
  const pushed = mcpNotifications.map((n) => JSON.stringify(n)).join("\n");
  if (pushed.includes(NONCE)) {
    drained += pushed;
    break;
  }
  await sleep(2000);
}
console.log("--- what Claude saw ---");
console.log(drained.trim().slice(0, 1200));
check("Codex's reply reached Claude with the nonce intact", drained.includes(NONCE));

// ── T2.7 shutdown ──────────────────────────────────────────────

console.log("\n== T2.7 clean shutdown ==");
mcp.kill("SIGTERM");
await sleep(1500);
daemon.kill("SIGTERM");
await sleep(2500);
check("app-server port released", !(await portOpen(APP_PORT)));
check("proxy port released", !(await portOpen(PROXY_PORT)));

if (fail > 0) {
  console.log("\n--- daemon stderr (tail) ---");
  console.log(daemonErr.join("").slice(-4000));
  console.log("\n--- bridge stderr (tail) ---");
  console.log(mcpErr.join("").slice(-2000));
}

console.log(`\n======== T2 total: ${pass} passed, ${fail} failed ========`);
cleanup();
process.exit(fail > 0 ? 1 : 0);
