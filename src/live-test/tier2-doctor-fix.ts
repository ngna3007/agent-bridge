#!/usr/bin/env bun
/**
 * Tier 2 — `abg doctor --fix` against real broken state.
 *
 * Every repair in doctor.ts re-checks its precondition before acting,
 * because a diagnosis printed seconds ago can be stale by the time the
 * user reads it. Unit tests cover the predicates; this proves the
 * repairs themselves against a real state dir, a real config file, and
 * a real orphan process — including the refusals, which are the half
 * that can quietly cause damage if they ever stop working.
 *
 * Covered:
 *   D1  drifted config.json codex ports  -> rewritten, other keys kept
 *   D2  stale daemon.pid                 -> removed
 *   D2b live daemon.pid                  -> refused (would strand a daemon)
 *   D3  stale startup.lock               -> removed
 *   D3b fresh startup.lock               -> refused (would reopen the race)
 *   D4  orphan bridge-server             -> reaped
 *
 * No model tokens: nothing here starts Codex or Claude.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dir, "../..");
const LAB = join(tmpdir(), "agentbridge-doctor-lab");
const CLI = join(REPO, "src/cli.ts");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(LAB, { recursive: true, force: true });
const projectRoot = join(LAB, "proj");
const stateDir = join(LAB, "state");
mkdirSync(join(projectRoot, ".agentbridge"), { recursive: true });
mkdirSync(stateDir, { recursive: true });

/** Run `abg doctor` in the lab project with an explicit state dir. */
async function doctor(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, "doctor", ...args], {
    cwd: projectRoot,
    env: { ...process.env, AGENTBRIDGE_STATE_DIR: stateDir, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { out: `${out}\n${err}`, code };
}

// ── D1. drifted config ports ───────────────────────────────────

console.log("\n== D1 doctor --fix rewrites drifted config ports ==");

const configPath = join(projectRoot, ".agentbridge", "config.json");
// Deliberately wrong ports, plus a hand-tuned key that must survive.
writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: "1.0",
      codex: { appPort: 4500, proxyPort: 4501 },
      turnCoordination: { attentionWindowSeconds: 99 },
      idleShutdownSeconds: 4242,
    },
    null,
    2,
  ),
);

const drifted = await doctor();
check("doctor reports the port drift", /drift from project-derived/i.test(drifted.out), drifted.out.slice(0, 300));
check("doctor says --fix can repair it", /abg doctor --fix/.test(drifted.out));

const fixed = await doctor("--fix");
check("--fix reports rewriting the ports", /rewrote codex ports/i.test(fixed.out), fixed.out.slice(0, 400));

let cfgAfter: any = {};
try {
  cfgAfter = JSON.parse(readFileSync(configPath, "utf-8"));
} catch {}
const derived = /expected appPort=(\d+), proxyPort=(\d+)/.exec(drifted.out);
const wantApp = derived ? Number(derived[1]) : -1;
const wantProxy = derived ? Number(derived[2]) : -2;
check(
  "config.json now holds the derived ports",
  cfgAfter?.codex?.appPort === wantApp && cfgAfter?.codex?.proxyPort === wantProxy,
  `got ${JSON.stringify(cfgAfter?.codex)}, wanted appPort=${wantApp} proxyPort=${wantProxy}`,
);
check(
  "the hand-tuned keys survived the rewrite",
  cfgAfter?.turnCoordination?.attentionWindowSeconds === 99 && cfgAfter?.idleShutdownSeconds === 4242,
  JSON.stringify(cfgAfter),
);

const clean = await doctor();
check("the drift finding is gone on the next run", !/drift from project-derived/i.test(clean.out));

// ── D2. stale vs. live daemon.pid ──────────────────────────────

console.log("\n== D2 doctor --fix removes a stale daemon.pid, keeps a live one ==");

const pidPath = join(stateDir, "daemon.pid");

// A pid that is certainly dead: spawn something trivial and wait for it.
const corpse = Bun.spawn(["true"]);
await corpse.exited;
writeFileSync(pidPath, String(corpse.pid));

const stalePid = await doctor();
check("doctor reports the stale pid file", /Stale daemon\.pid/i.test(stalePid.out), stalePid.out.slice(0, 300));

const pidFixed = await doctor("--fix");
check("--fix reports removing it", /removed stale daemon\.pid/i.test(pidFixed.out), pidFixed.out.slice(0, 400));
check("daemon.pid is gone from disk", !existsSync(pidPath));

// Now the dangerous case: the pid file names a process that is alive.
// Nothing should be deleted — deleting it strands a real daemon.
const livePid = Bun.spawn(["sleep", "30"]);
writeFileSync(pidPath, String(livePid.pid));
const liveRun = await doctor("--fix");
check(
  "a live pid is not reported stale",
  !/Stale daemon\.pid/i.test(liveRun.out),
  liveRun.out.slice(0, 300),
);
check("doctor sees it as a running daemon", new RegExp(`Daemon running \\(pid ${livePid.pid}\\)`).test(liveRun.out));
check("the live daemon.pid file was left alone", existsSync(pidPath));
livePid.kill();
await sleep(200);
rmSync(pidPath, { force: true });

// ── D3. stale vs. fresh startup.lock ───────────────────────────

console.log("\n== D3 doctor --fix removes a stale startup.lock, keeps a fresh one ==");

const lockPath = join(stateDir, "startup.lock");
writeFileSync(lockPath, "1");
// Backdate it well past the 30s staleness threshold.
const old = new Date(Date.now() - 10 * 60_000);
utimesSync(lockPath, old, old);

const staleLock = await doctor();
check("doctor reports the stale lock", /Stale startup\.lock/i.test(staleLock.out), staleLock.out.slice(0, 300));

const lockFixed = await doctor("--fix");
check("--fix reports removing it", /removed stale startup\.lock/i.test(lockFixed.out), lockFixed.out.slice(0, 400));
check("startup.lock is gone from disk", !existsSync(lockPath));

// A lock written just now is a launch in progress, not garbage.
writeFileSync(lockPath, "1");
const freshLock = await doctor("--fix");
check("a fresh lock is not reported stale", !/Stale startup\.lock/i.test(freshLock.out));
check("doctor says a daemon may be starting", /daemon may be starting/i.test(freshLock.out));
check("the fresh startup.lock was left alone", existsSync(lockPath));
rmSync(lockPath, { force: true });

// ── D4. orphan bridge-server ───────────────────────────────────

console.log("\n== D4 doctor --fix reaps an orphan bridge-server ==");

// The predicate wants: our state dir in the env, "bridge-server" in the
// command line, and a parent that is gone. `setsid` gives us the last
// one — the intermediate exits immediately and the child reparents.
const orphanScript = join(LAB, "bridge-server.js");
writeFileSync(orphanScript, "setInterval(() => {}, 1000);\n");
Bun.spawnSync(["setsid", "--fork", "bun", "run", orphanScript], {
  env: { ...process.env, AGENTBRIDGE_STATE_DIR: stateDir },
  stdout: "ignore",
  stderr: "ignore",
});
await sleep(1500);

const orphanRun = await doctor();
const sawOrphan = /orphan bridge-server/i.test(orphanRun.out);
check("doctor reports the orphan bridge-server", sawOrphan, orphanRun.out.slice(0, 400));

if (sawOrphan) {
  const orphanFixed = await doctor("--fix");
  check(
    "--fix reports reaping it",
    /sent SIGTERM to orphan bridge-server/i.test(orphanFixed.out),
    orphanFixed.out.slice(0, 400),
  );
  await sleep(1000);
  const after = await doctor();
  check("no orphan remains on the next run", !/orphan bridge-server/i.test(after.out), after.out.slice(0, 300));
} else {
  console.log("  SKIP  reap checks (could not create a reparented orphan in this environment)");
}
// Whatever happened above, do not leave a spinning process behind.
Bun.spawnSync(["pkill", "-f", orphanScript]);

// ── D5. nothing left to fix ────────────────────────────────────

console.log("\n== D5 --fix on a healthy state dir does nothing ==");

const idle = await doctor("--fix");
check("no repair lines on a clean run", !/^\s*fixed\s/m.test(idle.out), idle.out.slice(0, 400));
check("doctor still exits cleanly", idle.code === 0 || idle.code === 1, `exit=${idle.code}`);

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(LAB, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
