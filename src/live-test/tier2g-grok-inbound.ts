#!/usr/bin/env bun
/**
 * Tier 2g — can the bus actually reach a non-Claude frontend?
 *
 * Per-agent frontend slots (#11) let a second agent attach and send into
 * the bus without evicting Claude. That is the outbound half. This harness
 * asks the other question, the one that decides whether a non-Claude
 * frontend is a peer or a megaphone: when Codex says something, does that
 * frontend ever learn it?
 *
 * There are two delivery paths out of the daemon and a frontend's fate
 * differs on each:
 *
 *   push   `[REPLY]`-tagged output. `ClaudeAdapter.pushViaChannel` emits
 *          `notifications/claude/channel` — a Claude Code extension to MCP.
 *          Base MCP has no server-push wake-up, so a non-Claude client can
 *          only ignore an unknown notification. Ignoring it is not an
 *          error, so the send *succeeds*, and the adapter's queue fallback
 *          (which only runs when the send throws) never fires.
 *   queue  untagged output. Parked in the pull queue and handed over when
 *          the agent calls `get_messages`, an ordinary MCP tool.
 *
 * The prediction under test: **pull reaches any frontend; push reaches only
 * a client that understands Claude's channel extension, and what it misses
 * is gone rather than deferred.** `[REPLY]` is the marker the role files
 * tell Codex to use for direct answers, so if this holds, the highest-value
 * message class is exactly the one a Grok frontend cannot receive.
 *
 * Why this does not drive a real `grok`
 * ------------------------------------
 * It did at first, and that version could not tell the two failures apart:
 * a Grok that ignores the notification and a Grok that never ran produce
 * the same empty output. The claim is about a delivery path, and the path
 * is production code either way — `grok` spawns `src/bridge.ts` and speaks
 * MCP to it, so an MCP client of our own reaches the identical code with no
 * model in the loop, no tokens, and no flake. `docs/scaling-plan.md` §4.1b
 * already establishes that a real Grok completes this handshake and
 * resolves these tools by name.
 *
 * What that leaves unproven is one narrow thing: whether some future Grok
 * *does* consume `notifications/claude/channel`. Nothing in grok 0.2.118
 * suggests it, and no MCP client can be expected to act on a vendor
 * extension it never declared — but it is a claim about someone else's
 * binary, so it stays a prediction rather than an assertion here.
 *
 * Codex is `fake-codex-app-server.ts`, reached by putting `fake-codex-bin/`
 * first on PATH — the point here is the delivery path, not the model, and a
 * fake gives turn timing the harness controls. Everything between it and
 * the frontends is production code.
 *
 * Free and deterministic. Run: bun run test:live:grok-inbound
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const LAB = "/tmp/abg-grok-in-lab";
const WORK = join(LAB, "work");
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHIM_BIN = join(REPO, "src/live-test/fake-codex-bin");

const NONCE_PUSH = "ABG-PUSHPATH-7Q4";
const NONCE_PULL = "ABG-PULLPATH-2M8";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

interface Status {
  attachedAgents: string[];
  claudeAttached: boolean;
}

async function status(port: number): Promise<Status | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return (await res.json()) as Status;
  } catch {
    return null;
  }
}

function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", CLI, ...args], { cwd: WORK, stdio: "ignore" });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
}

/**
 * Kill whatever still listens on the lab's app-server port after `abg kill`.
 *
 * Pre-existing defect, not something this harness causes: on an npm/nvm
 * install the pid the daemon records is a Node wrapper, and the process
 * actually holding the port is its child, which outlives the SIGTERM. On the
 * next start `classifyPortHolder` sees an unrecorded pid, calls it
 * `foreign-codex`, and refuses to start. This reaper does not fix that — it
 * only stops one leaked run from failing the next, and says so when it fires.
 */
function reapOrphanAppServer(port: number) {
  let pids: string;
  try {
    pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
  } catch {
    return;
  }
  if (!pids) return;
  console.log(`  WARN  app-server survived \`abg kill\` on port ${port}: PID(s) ${pids.split("\n").join(", ")}`);
  for (const raw of pids.split("\n")) {
    const pid = parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

/**
 * One MCP client over a real `src/bridge.ts`, declaring a given agent
 * identity — i.e. exactly what `abg claude` and `abg grok` each launch.
 */
function makeFrontend(agent: string, env: Record<string, string>) {
  const proc = spawn("bun", ["run", join(REPO, "src/bridge.ts")], {
    cwd: WORK,
    env: { ...process.env, ...env, AGENTBRIDGE_ACTIVE: "1", AGENTBRIDGE_AGENT: agent },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const notifications: Array<{ method: string; params?: any }> = [];
  const stderr: string[] = [];
  let nextId = 1;
  let buf = "";

  proc.stderr.on("data", (b) => stderr.push(String(b)));
  proc.stdout.on("data", (b) => {
    buf += String(b);
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });

  function send(payload: unknown) {
    proc.stdin.write(JSON.stringify(payload) + "\n");
  }
  function request(method: string, params?: unknown, timeoutMs = 30_000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
    });
  }
  async function handshake() {
    // No `experimental` capabilities declared — a plain MCP client, which
    // is what any non-Claude host is.
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: `agentbridge-tier2g-${agent}`, version: "0.0.1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  return { proc, notifications, stderr, request, handshake };
}

/** Text of every channel notification this frontend received. */
function channelTexts(notifications: Array<{ method: string; params?: any }>): string {
  return notifications
    .filter((n) => n.method === "notifications/claude/channel")
    .map((n) => String(n.params?.content ?? ""))
    .join("\n");
}

/** Text of everything `get_messages` handed back. */
async function drain(frontend: ReturnType<typeof makeFrontend>): Promise<string> {
  const res = await frontend.request("tools/call", { name: "get_messages", arguments: {} });
  return JSON.stringify(res);
}

async function main() {
  if (existsSync(LAB)) rmSync(LAB, { recursive: true, force: true });
  mkdirSync(join(WORK, ".agentbridge"), { recursive: true });

  process.env.PATH = `${SHIM_BIN}:${process.env.PATH}`;
  process.env.FAKE_REPLY_PREFIX = "";
  process.env.FAKE_TURN_MS = "400";

  process.chdir(WORK);
  const { resolveRuntimeNamespace } = await import("../runtime-namespace");
  const ns = resolveRuntimeNamespace({ mutateEnv: true });
  if (!ns.project) {
    console.error("Lab project did not resolve — .agentbridge/ marker missing?");
    process.exit(1);
  }
  const { control: controlPort, codexProxy: proxyPort, codexWs } = ns.project.ports;
  console.log(`Lab: ${WORK}  project ${ns.project.projectId}  control ${controlPort}\n`);

  await runCli(["kill"]);
  reapOrphanAppServer(codexWs);

  const env: Record<string, string> = {
    AGENTBRIDGE_FILTER_MODE: "filtered",
    // Default delivery. Stated rather than inherited, because the whole
    // question is what push does to a client that cannot receive it.
    AGENTBRIDGE_MODE: "push",
  };

  console.log("Starting the daemon (fake codex app-server on PATH)...");
  const { StateDirResolver } = await import("../state-dir");
  const { DaemonLifecycle } = await import("../daemon-lifecycle");
  const stateDir = new StateDirResolver();
  stateDir.ensure();
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.log(`  [daemon] ${msg}`),
  });
  lifecycle.clearKilled();
  await lifecycle.ensureRunning();

  // ── a fake Codex TUI, so the adapter has a thread to carry turns on ──
  const tuiPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let tuiNextId = 1;
  const tui = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
  await new Promise<void>((resolve, reject) => {
    tui.addEventListener("open", () => resolve());
    tui.addEventListener("error", () => reject(new Error("TUI socket error")));
    setTimeout(() => reject(new Error("TUI connect timeout")), 15_000);
  });
  tui.addEventListener("message", (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id === undefined) return;
    const p = tuiPending.get(msg.id);
    if (!p) return;
    tuiPending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  function tuiRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = tuiNextId++;
    return new Promise((resolve, reject) => {
      tuiPending.set(id, { resolve, reject });
      tui.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (tuiPending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
    });
  }

  await tuiRequest("initialize", {
    clientInfo: { name: "agentbridge-tier2g-fake-tui", title: "Tier 2g harness", version: "0.0.1" },
  });
  tui.send(JSON.stringify({ method: "initialized", params: {} }));
  const started = await tuiRequest("thread/start", { cwd: WORK, sandbox: "read-only", approvalPolicy: "never" });
  const threadId: string = started?.thread?.id ?? "";
  check("the fake Codex TUI has a thread", threadId.length > 0, JSON.stringify(started).slice(0, 200));
  if (!threadId) { await runCli(["kill"]); process.exit(1); }

  // ── two frontends, side by side ──
  console.log("Attaching a Claude frontend and a Grok frontend...");
  const claude = makeFrontend("claude", env);
  const grok = makeFrontend("grok", env);
  await claude.handshake();
  await grok.handshake();

  // Attaching makes the daemon send Codex a kickoff turn. Let it finish, or
  // the harness's own turns bounce off `turnInProgress`.
  await Bun.sleep(4000);

  const both = await status(controlPort);
  check(
    "both frontends hold a slot at once",
    Boolean(both?.attachedAgents.includes("claude") && both?.attachedAgents.includes("grok")),
    `attachedAgents=${JSON.stringify(both?.attachedAgents)}`,
  );

  const tools = await grok.request("tools/list");
  const toolNames: string[] = (tools?.tools ?? []).map((t: any) => t.name);
  check(
    "the Grok frontend gets the same tool surface as Claude",
    toolNames.includes("reply") && toolNames.includes("get_messages"),
    toolNames.join(","),
  );

  // ── Codex speaks once on each delivery path ──
  console.log("Codex emits one [REPLY] (push path) and one untagged message (queue path)...");
  await tuiRequest("turn/start", { threadId, input: [{ type: "text", text: `[REPLY] ${NONCE_PUSH}` }] });
  await Bun.sleep(2500);
  await tuiRequest("turn/start", { threadId, input: [{ type: "text", text: `${NONCE_PULL} progress note` }] });
  await Bun.sleep(2500);

  const claudePushed = channelTexts(claude.notifications);
  const grokPushed = channelTexts(grok.notifications);
  const claudeQueue = await drain(claude);
  const grokQueue = await drain(grok);

  console.log("");
  check(
    "the daemon fans a Codex message out to every attached frontend",
    claudePushed.includes(NONCE_PUSH) && grokPushed.includes(NONCE_PUSH),
    `claude=${claudePushed.includes(NONCE_PUSH)} grok=${grokPushed.includes(NONCE_PUSH)}`,
  );
  check(
    "the queue path reaches the Grok frontend — get_messages returns the untagged message",
    grokQueue.includes(NONCE_PULL),
    `${NONCE_PULL} absent from get_messages`,
  );
  check(
    "the queue path reaches Claude too",
    claudeQueue.includes(NONCE_PULL),
    `${NONCE_PULL} absent from get_messages`,
  );

  // The finding. A `[REPLY]` leaves the daemon as a channel notification and
  // is not also queued, because the send did not throw — an MCP client that
  // does not implement Claude's channel extension simply drops it on the
  // floor and `get_messages` will never mention it again. Asserted as a
  // characterization test: this is what the code does today, and a change
  // in either direction should make someone look.
  check(
    "a [REPLY] is delivered ONLY as a channel notification, never also queued",
    !grokQueue.includes(NONCE_PUSH) && !claudeQueue.includes(NONCE_PUSH),
    `grokQueue has it=${grokQueue.includes(NONCE_PUSH)} claudeQueue has it=${claudeQueue.includes(NONCE_PUSH)}`,
  );
  console.log(
    "  NOTE  so any frontend that ignores notifications/claude/channel loses every\n" +
      "        [REPLY] permanently — the marker Codex is told to use for direct answers.",
  );

  console.log("");
  try { tui.close(); } catch {}
  try { claude.proc.kill("SIGTERM"); grok.proc.kill("SIGTERM"); } catch {}
  await runCli(["kill"]);
  reapOrphanAppServer(codexWs);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
