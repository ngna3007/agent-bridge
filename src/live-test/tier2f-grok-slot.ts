#!/usr/bin/env bun
/**
 * Tier 2f — does a real Grok Build take its own frontend slot?
 *
 * The outbound half of the Grok integration (`docs/scaling-plan.md` §4.1b).
 * Tier 2e covers the inbound half over the leader socket; this covers the
 * direction that needs no adapter at all, because Grok reads Claude Code's
 * plugin registry and so already loads our MCP server.
 *
 * What is actually under test is `abg grok`, which contributes exactly two
 * environment variables:
 *
 *   AGENTBRIDGE_ACTIVE=1     without it `bridge.ts` self-exits and Grok
 *                            reports a broken pipe, which is how §4.1b found
 *                            this whole path in the first place.
 *   AGENTBRIDGE_AGENT=grok   without it Grok attaches as Claude, and the two
 *                            evict each other over one slot.
 *
 * So the assertion is about identity, not transport: the daemon must show
 * `grok` attached, and a Claude frontend attached at the same time must still
 * be there afterwards.
 *
 * Runs in its own scratch project, so it gets its own port triple and cannot
 * disturb a daemon you have running for real work.
 *
 * **Costs real xAI tokens** — one short model turn. Not in `bun test src`.
 *
 * Run: bun run test:live:grok-slot
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Short path on purpose, matching tier2e: Grok's leader socket lives under
// $GROK_HOME and unix socket paths are capped around SUN_LEN (~108 chars).
const LAB = "/tmp/abg-grok-slot-lab";
const WORK = join(LAB, "work");
const REAL_GROK_HOME = join(homedir(), ".grok");
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

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
  claudeAttached: boolean;
  attachedAgents: string[];
}

async function status(port: number): Promise<Status | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Status;
  } catch {
    return null;
  }
}

/** Run `abg <args>` in the lab and resolve with its exit code. */
function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", CLI, ...args], {
      cwd: WORK,
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
}

/**
 * Kill whatever still listens on the lab's app-server port after `abg kill`.
 *
 * `abg kill` SIGTERMs the daemon, which SIGTERMs the `codex app-server` it
 * spawned — but on an npm/nvm install that pid is a Node wrapper, and the
 * binary it launched is a *grandchild* that outlives the signal. The daemon
 * records the wrapper's pid, so on the next start `classifyPortHolder` sees
 * an unrecorded pid on the port, calls it `foreign-codex`, and refuses to
 * start with "another AgentBridge project derives the same ports as this
 * one". Second run of this harness in a row hits exactly that.
 *
 * That is a product defect, not a test-setup problem, and this reaper does
 * not fix it — it only stops one leaked run from failing the next one, and
 * says so loudly when it fires. Safe here because the lab derives a port
 * triple no other project shares.
 */
function reapOrphanAppServer(port: number) {
  let pids: string;
  try {
    pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
  } catch {
    return; // lsof exits non-zero when nothing holds the port — the good case.
  }
  if (!pids) return;
  console.log(`  WARN  app-server survived \`abg kill\` on port ${port}: PID(s) ${pids.split("\n").join(", ")}`);
  console.log("        (pre-existing: the recorded pid is the node wrapper, not the listener)");
  for (const raw of pids.split("\n")) {
    const pid = parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

async function main() {
  if (existsSync(LAB)) rmSync(LAB, { recursive: true, force: true });
  mkdirSync(join(WORK, ".agentbridge"), { recursive: true });

  // An isolated GROK_HOME, as in tier2e: everything Grok reads or writes —
  // config, MCP registration, folder trust, session files — stays in the lab.
  // Credentials are symlinked rather than copied so no token is duplicated
  // onto disk.
  for (const name of ["auth.json", "agent_id"]) {
    const real = join(REAL_GROK_HOME, name);
    if (!existsSync(real)) {
      console.error(`Missing ${real} — run \`grok\` once and sign in first.`);
      process.exit(1);
    }
    symlinkSync(real, join(LAB, name));
  }

  // Point Grok at the bundle in *this checkout*.
  //
  // In normal use Grok finds our MCP server by reading Claude Code's plugin
  // registry and needs no config at all — that is the §4.1b finding. But the
  // registry serves whatever version is installed there, which on a dev
  // machine is whatever was last published, not what you just built. Testing
  // through it would tell you about the installed plugin instead of about
  // your working tree. Run `bun run build:plugin` first.
  //
  // Registered at *user* scope (the lab's own config.toml) rather than in
  // WORK/.grok/, deliberately: that is the same scope the plugin registry
  // occupies in real use, and Grok refuses to start repo-local servers in a
  // folder it does not trust.
  const bundle = fileURLToPath(new URL("../../plugins/agentbridge/server/bridge-server.js", import.meta.url));
  if (!existsSync(bundle)) {
    console.error(`Plugin bundle missing: ${bundle}\nRun: bun run build:plugin`);
    process.exit(1);
  }
  writeFileSync(
    join(LAB, "config.toml"),
    [
      "[ui]",
      `permission_mode = "always-approve"`,
      "yolo = true",
      "",
      "[mcp_servers.agentbridge]",
      `command = "bun"`,
      `args = ["run", ${JSON.stringify(bundle)}]`,
      "enabled = true",
      "",
      "[mcp_servers.agentbridge.env]",
      `AGENTBRIDGE_DAEMON_ENTRY = ${JSON.stringify(join(dirname(bundle), "daemon.js"))}`,
      "",
    ].join("\n"),
    "utf-8",
  );

  // Trust the work folder up front. Grok asks interactively on first visit,
  // and `-p` has no one to ask — an untrusted folder silently skips MCP
  // startup, which reads exactly like the bug this test is looking for.
  writeFileSync(
    join(LAB, "trusted_folders.toml"),
    `[folders."${WORK}"]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`,
    "utf-8",
  );

  // Ports derive from the project root path, so resolve them the way the
  // runtime will rather than guessing. Requires the cwd to be the project.
  // `mutateEnv` because the daemon we are about to start reads its ports and
  // its state dir out of the environment.
  process.chdir(WORK);
  const { resolveRuntimeNamespace } = await import("../runtime-namespace");
  const ns = resolveRuntimeNamespace({ mutateEnv: true });
  if (!ns.project) {
    console.error("Lab project did not resolve — .agentbridge/ marker missing?");
    process.exit(1);
  }
  const controlPort = ns.project.ports.control;
  console.log(`Lab: ${WORK}  project ${ns.project.projectId}  control ${controlPort}\n`);

  // Stand the daemon and a Claude frontend up FIRST, then bring Grok in
  // beside them. That is the real sequence — you have `abg claude` running
  // in another terminal — and it is also the only version that can observe
  // anything: a cold daemon takes ~5s to answer, while a headless `-p` turn
  // is over in ~3s, so a from-scratch launch exits before its own slot is
  // visible.
  // Pre-flight. Two ways a previous run can poison this one, both of them
  // pre-existing daemon behaviour rather than anything this test does:
  //   - a `codex app-server` that outlived `abg kill` still holds the port;
  //   - a daemon whose Codex startup failed stays up answering /healthz
  //     while never becoming ready, and `ensureRunning` short-circuits on
  //     healthy, so it waits for a readiness that will never come.
  // Clearing the field first makes the harness repeatable.
  await runCli(["kill"]);
  reapOrphanAppServer(ns.project.ports.codexWs);

  console.log("Starting the daemon and attaching a Claude frontend...");
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

  const claudeWs = new WebSocket(`ws://127.0.0.1:${controlPort}/ws`);
  claudeWs.addEventListener("open", () => {
    claudeWs.send(JSON.stringify({ type: "claude_connect", agent: "claude" }));
  });
  const claudeDeadline = Date.now() + 15_000;
  let claudeReady = false;
  while (Date.now() < claudeDeadline) {
    if ((await status(controlPort))?.claudeAttached) {
      claudeReady = true;
      break;
    }
    await Bun.sleep(200);
  }
  if (!claudeReady) {
    console.error("Claude frontend never attached — nothing to test against.");
    process.exit(1);
  }

  console.log("Launching `abg grok -p` (one short model turn)...");
  const grok = spawn(process.execPath, ["run", CLI, "grok", "-p", "Reply with exactly: OK"], {
    cwd: WORK,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GROK_HOME: LAB },
  });
  let grokOut = "";
  grok.stdout.on("data", (b) => { grokOut += String(b); });
  grok.stderr.on("data", (b) => { grokOut += String(b); });

  const exited = new Promise<number>((r) => grok.on("exit", (c) => r(c ?? 0)));

  // Poll while the turn runs. The attach happens at the MCP handshake, well
  // before the model answers, but Grok exits as soon as it has answered — a
  // single post-hoc check would find the slot already released.
  let sawGrok: Status | null = null;
  const deadline = Date.now() + 120_000;
  let done = false;
  exited.then(() => { done = true; });

  while (!done && Date.now() < deadline) {
    const s = await status(controlPort);
    if (s?.attachedAgents.includes("grok")) sawGrok ??= s;
    await Bun.sleep(200);
  }

  const code = await exited;
  const after = await status(controlPort);
  try { claudeWs.close(); } catch {}

  console.log("");
  check("grok exited cleanly", code === 0, `exit ${code}`);
  check(
    "grok took a frontend slot of its own",
    sawGrok !== null,
    sawGrok ? "" : 'never saw "grok" in attachedAgents',
  );
  // The pre-0.8 failure, stated two ways: Grok used to attach *as* Claude,
  // so the first sample that shows Grok would have shown Claude gone.
  check(
    "Claude kept its slot while Grok held one",
    sawGrok?.claudeAttached === true,
    sawGrok ? `claudeAttached=${sawGrok.claudeAttached}` : "no sample",
  );
  check(
    "both agents were attached at once",
    sawGrok !== null && sawGrok.attachedAgents.includes("claude") && sawGrok.attachedAgents.includes("grok"),
    `attachedAgents=${JSON.stringify(sawGrok?.attachedAgents)}`,
  );
  check(
    "the Claude frontend outlived Grok's whole session",
    after?.claudeAttached === true,
    `claudeAttached=${after?.claudeAttached}`,
  );
  check(
    "Grok released its slot on exit",
    after !== null && !after.attachedAgents.includes("grok"),
    `attachedAgents=${JSON.stringify(after?.attachedAgents)}`,
  );

  if (fail > 0) {
    console.log("\n--- grok output ---");
    console.log(grokOut.trim().slice(0, 2000));
  }

  console.log("");
  await runCli(["kill"]);
  reapOrphanAppServer(ns.project.ports.codexWs);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
