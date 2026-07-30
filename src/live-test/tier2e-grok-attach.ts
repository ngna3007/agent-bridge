#!/usr/bin/env bun
/**
 * Tier 2e — can AgentBridge reach a session someone else owns in Grok Build?
 *
 * This is the gate `docs/scaling-plan.md` §4.1a records. The Codex adapter
 * works by injecting a turn into a session a human already has open; a Grok
 * target only exists if Grok's leader allows the same thing. The plan's
 * original assumption was that it does not — that `session/update` routes to
 * one owner and attaching would steal the human's stream. The experiment
 * refuted that, and this harness is what keeps the refutation honest as grok
 * ships new versions.
 *
 * Client A stands in for the human's TUI: it owns the session.
 * Client B stands in for AgentBridge: it was never invited.
 *
 * **Costs real xAI tokens** — two short model turns. Not in `bun test src`.
 *
 * The TUI half of §4.1a (a real `grok` TUI under a pty, and whether the
 * injected turn lands in the human's own transcript) is not automated here:
 * it needs a pty, a stdin that stays open, and a human to confirm what was
 * drawn on screen. That stays Tier 3.
 *
 * Run: bun run test:live:grok
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Deliberately not tmpdir(): the leader socket is $GROK_HOME/leader.sock and
// unix socket paths are capped at SUN_LEN (~108 chars). A long lab path fails
// as `path must be shorter than SUN_LEN`, then as a socket-creation timeout.
const LAB = "/tmp/abg-grok-lab";
const WORK = join(LAB, "work");
const REAL_GROK_HOME = join(homedir(), ".grok");
const NONCE_B = "ABG-INJECT-B";
const NONCE_A = "ABG-OWNER-A";

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

if (!existsSync(join(REAL_GROK_HOME, "auth.json"))) {
  console.log("No ~/.grok/auth.json — run `grok login` first. Skipping.");
  process.exit(0);
}

// An isolated GROK_HOME, so enabling leader mode never touches the user's own
// config. Credentials are symlinked rather than copied.
rmSync(LAB, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
symlinkSync(join(REAL_GROK_HOME, "auth.json"), join(LAB, "auth.json"));
symlinkSync(join(REAL_GROK_HOME, "agent_id"), join(LAB, "agent_id"));
writeFileSync(
  join(LAB, "config.toml"),
  '[cli]\nuse_leader = true\n\n[ui]\npermission_mode = "always-approve"\nyolo = true\n',
);

const ENV = { ...process.env, GROK_HOME: LAB };
const spawned: ReturnType<typeof Bun.spawn>[] = [];

interface Client {
  send: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
  /** Every `session/update` text chunk this client saw, in order. */
  chunks: string[];
  proc: ReturnType<typeof Bun.spawn>;
}

function spawnClient(): Client {
  const proc = Bun.spawn(["grok", "agent", "--always-approve", "--leader", "stdio"], {
    cwd: WORK,
    env: ENV,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(proc);

  const pending = new Map<number, (v: any) => void>();
  const chunks: string[] = [];
  let nextId = 1;

  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          pending.get(msg.id)?.(msg.error ? { __error: msg.error } : msg.result);
          pending.delete(msg.id);
          continue;
        }
        const text = msg.method ? msg.params?.update?.content?.text : undefined;
        if (typeof text === "string") chunks.push(text);
      }
    }
  })();

  return {
    proc,
    chunks,
    send: (method, params, timeoutMs = 90_000) => {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        proc.stdin.flush();
        setTimeout(() => {
          if (pending.delete(id)) resolve({ __timeout: true });
        }, timeoutMs);
      });
    },
  };
}

function cleanup() {
  for (const p of spawned) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    Bun.spawnSync(["grok", "leader", "kill"], { env: ENV });
  } catch {
    /* leader may never have started */
  }
  rmSync(LAB, { recursive: true, force: true });
}

const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

console.log("\n== A owns a session on the shared leader ==");
const a = spawnClient();
const aInit = await a.send("initialize", INIT, 60_000);
check("client A completes the ACP handshake", typeof (aInit as any)?.protocolVersion === "number",
  JSON.stringify(aInit)?.slice(0, 200));

const aNew = await a.send("session/new", { cwd: WORK, mcpServers: [], _meta: { yoloMode: true } });
const sessionId = (aNew as any)?.sessionId;
check("client A gets a session id", typeof sessionId === "string", JSON.stringify(aNew)?.slice(0, 200));
if (!sessionId) {
  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(1);
}

// The lock file the listing reads is written a little after the session comes
// up, so this polls rather than sampling once.
let leaderOut = "";
for (let i = 0; i < 15; i++) {
  const listed = Bun.spawnSync(["grok", "leader", "list"], { env: ENV, stdout: "pipe", stderr: "pipe" });
  leaderOut = new TextDecoder().decode(listed.stdout) + new TextDecoder().decode(listed.stderr);
  if (/Reachable/.test(leaderOut)) break;
  await sleep(1000);
}
check("a leader is running and reachable", /Reachable/.test(leaderOut),
  leaderOut.trim().replace(/\n/g, " | ") || "(no output)");

console.log("\n== B prompts A's session, uninvited and without session/load ==");
const b = spawnClient();
await b.send("initialize", INIT, 60_000);

const injected = await b.send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: `Reply with exactly this and nothing else: ${NONCE_B}` }],
});
check("the leader accepts a prompt from a client that does not own the session",
  (injected as any)?.stopReason === "end_turn", JSON.stringify(injected)?.slice(0, 200));

await sleep(3000);
// The whole Grok target rests on this pair: if only B saw the reply, attaching
// would blank the human's screen and the design would need a WS proxy instead.
check("the owner still receives the stream for a turn it did not start",
  a.chunks.join("").includes(NONCE_B), `${a.chunks.length} chunk(s)`);
check("the injecting client receives the same stream",
  b.chunks.join("").includes(NONCE_B), `${b.chunks.length} chunk(s)`);

console.log("\n== A still owns its session afterwards ==");
const aBefore = a.chunks.length;
const aOwn = await a.send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: `Reply with exactly this and nothing else: ${NONCE_A}` }],
});
check("the owner can still drive its own session", (aOwn as any)?.stopReason === "end_turn",
  JSON.stringify(aOwn)?.slice(0, 200));

await sleep(3000);
check("the owner sees its own turn", a.chunks.join("").includes(NONCE_A),
  `${a.chunks.length - aBefore} new chunk(s)`);
check("the attached client also sees the owner's turn", b.chunks.join("").includes(NONCE_A),
  `${b.chunks.length} chunk(s)`);

console.log("\n== discovery surface ==");
// These are the methods an adapter must NOT be written against: they appear in
// the grok binary but are not on the client-facing ACP surface. Session
// discovery reads $GROK_HOME/active_sessions.json instead.
for (const method of ["x.ai/sessions/list", "x.ai/session/interjection"]) {
  const r = await b.send(method, {}, 15_000);
  check(`${method} is still absent from the ACP surface`,
    (r as any)?.__error?.code === -32601, JSON.stringify(r)?.slice(0, 160));
}
check("live sessions are discoverable on disk", existsSync(join(LAB, "active_sessions.json")));

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
