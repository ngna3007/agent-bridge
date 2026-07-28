/**
 * `abg doctor` - diagnose stuck or surprising state and suggest the
 * fix. Read-only by default; `--fix` applies the repairs that are
 * provably safe. Output is a checklist of concrete diagnostics plus,
 * where useful, a copy-pasteable fix.
 *
 * `--fix` deliberately covers a small set. A finding earns a repair
 * only when the doctor has already *proved* the bad state rather than
 * inferred it — the pid it would delete has been checked dead, the
 * orphan it would signal has been checked parentless. Everything else
 * (role drift, an out-of-date rendered section, a listening port that
 * may well belong to something legitimate) stays advice, because
 * guessing wrong there destroys the user's work rather than tidying up
 * after a crash.
 *
 * Common scenarios it catches:
 *   - Stale daemon.pid (process died without removing the file).
 *   - Orphan bridge-server.js from a dead Claude session, still
 *     holding the daemon slot.
 *   - Codex app-server still listening on the project's codex port
 *     after the daemon went away.
 *   - Startup lock left behind by a crashed launch.
 *   - Old per-msg pin-contract mode enabled even though the new
 *     pinned AGENTS.md should suffice.
 *   - Mismatched ports between .agentbridge/config.json and the
 *     project-id derivation.
 *   - A role file that has drifted from the section it renders into,
 *     or that stopped explaining the routing markers.
 */

import { readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config-service";
import {
  findPidsByListenPort,
  findOrphanBridgeServers,
  isPidAlive,
} from "../process-helpers";
import { resolveRuntimeNamespace } from "../runtime-namespace";
import {
  ROLE_AGENTS,
  RoleFileError,
  missingRoutingMarkers,
  readRoleText,
  roleFilePath,
  syncRoleSections,
} from "../roles";

interface Finding {
  severity: "info" | "warn" | "error";
  message: string;
  fix?: string;
  /**
   * Applied by `--fix`. Returns a past-tense line describing what it
   * did, or throws with a reason. Present only on findings whose bad
   * state the doctor has verified, never on ones it inferred.
   */
  repair?: () => Promise<string>;
}

/**
 * Report on the role files and the sections they render into.
 *
 * Dry-run only — the doctor never repairs. Drift is worth naming
 * because it means a currently-running agent is on stale instructions:
 * the launcher re-renders at startup, so an edit made mid-session does
 * not reach the agent until it restarts.
 */
function checkRoles(projectRoot: string): Finding[] {
  const findings: Finding[] = [];

  for (const agent of ROLE_AGENTS) {
    const rolePath = roleFilePath(projectRoot, agent);
    const relRole = rolePath.startsWith(projectRoot)
      ? rolePath.slice(projectRoot.length + 1)
      : rolePath;

    if (!existsSync(rolePath)) {
      findings.push({
        severity: "info",
        message: `${relRole} missing - ${agent} runs on the built-in default role`,
        fix: `Fine if that is what you want. \`abg roles edit ${agent}\` writes the default to a file you can then change.`,
      });
      continue;
    }

    let outcomes;
    try {
      outcomes = syncRoleSections(projectRoot, { dryRun: true, agents: [agent] });
    } catch (err) {
      findings.push({
        severity: "error",
        message: err instanceof RoleFileError ? err.message.split("\n")[0] : String(err),
        fix: `Write the role text you want in ${relRole}, or delete the file to fall back to the built-in default.`,
      });
      continue;
    }

    for (const outcome of outcomes) {
      const relFile = outcome.file.startsWith(projectRoot)
        ? outcome.file.slice(projectRoot.length + 1)
        : outcome.file;
      if (outcome.status === "skipped") {
        findings.push({
          severity: "error",
          message: `${relFile}: cannot render role section - ${outcome.detail}`,
          fix: `Repair the AgentBridge markers in ${relFile}, then rerun.`,
        });
      } else if (outcome.status === "unchanged") {
        findings.push({
          severity: "info",
          message: `${relFile} role section matches ${relRole}`,
        });
      } else {
        findings.push({
          severity: "warn",
          message: `${relFile} role section is out of date with ${relRole} (would be ${outcome.status})`,
          fix: `Restart the agent (\`abg ${agent}\`) - it re-renders the section on launch. A running ${agent} session is still on the old text.`,
        });
      }
    }

    // A customized role that no longer explains the markers is legal
    // but usually accidental - the symptom shows up much later as
    // "the bridge stopped delivering".
    try {
      const role = readRoleText(projectRoot, agent);
      const missing = role.fromDefault ? [] : missingRoutingMarkers(role.text, agent);
      if (missing.length > 0) {
        findings.push({
          severity: "warn",
          message: `${relRole} never mentions ${missing.join(" ")}`,
          fix: `${agent} may stop tagging its messages, which sends them all to the pull queue. Re-add the marker rules, or \`abg roles reset ${agent}\` to start from the default again.`,
        });
      }
    } catch {
      /* already reported above */
    }
  }

  return findings;
}

export async function runDoctor(args: string[] = []) {
  const applyFixes = args.includes("--fix");
  const findings: Finding[] = [];

  // Read-only: resolveRuntimeNamespace gives us the same state dir
  // the runtime would actually use, so the doctor's checks match the
  // bridge's view instead of always landing on the platform default.
  const ns = resolveRuntimeNamespace({ mutateEnv: false });
  const project = ns.project;
  const stateDir = ns.stateDir;
  const dir = stateDir.dir;

  // ---- Project + namespace ----
  if (project) {
    findings.push({
      severity: "info",
      message: `Project ${project.projectId} at ${project.rootPath}`,
    });
    // Cross-check config.json ports vs derived (BOTH appPort and
    // proxyPort - a half-drift used to pass silently).
    try {
      const cs = new ConfigService(project.rootPath);
      const cfg = cs.load();
      if (cfg) {
        const appMismatch = cfg.codex.appPort !== project.ports.codexWs;
        const proxyMismatch = cfg.codex.proxyPort !== project.ports.codexProxy;
        if (appMismatch || proxyMismatch) {
          const expected = `appPort=${project.ports.codexWs}, proxyPort=${project.ports.codexProxy}`;
          const got = `appPort=${cfg.codex.appPort}, proxyPort=${cfg.codex.proxyPort}`;
          findings.push({
            severity: "warn",
            message:
              `config.json codex ports drift from project-derived (expected ${expected}, got ${got})`,
            fix:
              `Edit ${cs.configFilePath} to match the derived values, or rerun \`abg init\` after deleting .agentbridge/config.json.`,
            repair: async () => {
              // Only the two drifted fields change; every other key the
              // user may have tuned (attention window, idle shutdown)
              // is carried through untouched.
              cs.save({
                ...cfg,
                codex: { appPort: project.ports.codexWs, proxyPort: project.ports.codexProxy },
              });
              return `rewrote codex ports in ${cs.configFilePath} to ${expected}`;
            },
          });
        }
      }
    } catch {
      /* ignore */
    }

    findings.push(...checkRoles(project.rootPath));
  } else {
    findings.push({
      severity: "info",
      message: "No .agentbridge/ marker in this cwd or any ancestor (single-instance mode).",
    });
  }

  // ---- State dir + daemon pid ----
  findings.push({
    severity: "info",
    message: `State dir: ${dir}`,
  });

  const pidPath = join(dir, "daemon.pid");
  const lockPath = join(dir, "startup.lock");
  const killedSentinel = join(dir, "killed");

  if (existsSync(pidPath)) {
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    } catch {
      /* ignore */
    }
    if (pid && isPidAlive(pid)) {
      findings.push({ severity: "info", message: `Daemon running (pid ${pid})` });
    } else if (pid) {
      const deadPid = pid;
      findings.push({
        severity: "warn",
        message: `Stale daemon.pid (process ${pid} is dead)`,
        fix: `Run \`abg kill\` to clean up. Then \`abg claude\` or \`abg codex\` to restart.`,
        repair: async () => {
          // isPidAlive already said no. Re-check anyway: `abg doctor
          // --fix` can sit on screen while the user starts a daemon in
          // another terminal, and deleting a live daemon's pid file
          // strands it — nothing would ever find it to stop it again.
          if (isPidAlive(deadPid)) throw new Error(`pid ${deadPid} is alive again; left the file alone`);
          rmSync(pidPath, { force: true });
          return `removed stale daemon.pid (was ${deadPid})`;
        },
      });
    }
  } else {
    findings.push({ severity: "info", message: "No daemon.pid file (daemon not running)" });
  }

  if (existsSync(lockPath)) {
    let mtime: Date | null = null;
    try {
      mtime = statSync(lockPath).mtime;
    } catch {
      /* ignore */
    }
    const ageSec = mtime ? Math.round((Date.now() - mtime.getTime()) / 1000) : null;
    if (ageSec !== null && ageSec > 30) {
      findings.push({
        severity: "warn",
        message: `Stale startup.lock (age ${ageSec}s; daemon launch likely crashed)`,
        fix: `Run \`abg kill\` to remove the lock and reap orphans. Then retry.`,
        repair: async () => {
          // Re-read the mtime rather than trusting the one measured
          // during diagnosis: a launch that started since then would
          // have refreshed it, and removing a live lock reopens the
          // double-start race the lock exists to close.
          const nowAge = Math.round((Date.now() - statSync(lockPath).mtime.getTime()) / 1000);
          if (nowAge <= 30) throw new Error(`lock is only ${nowAge}s old now; a launch may be in progress`);
          rmSync(lockPath, { force: true });
          return `removed stale startup.lock (age ${nowAge}s)`;
        },
      });
    } else {
      findings.push({
        severity: "info",
        message: `Startup lock present (age ${ageSec ?? "?"}s; daemon may be starting)`,
      });
    }
  }

  if (existsSync(killedSentinel)) {
    findings.push({
      severity: "info",
      message: `Killed sentinel present (daemon was explicitly stopped with \`abg kill\`)`,
    });
  }

  // ---- Orphan bridge-servers ----
  const orphans = findOrphanBridgeServers(dir);
  if (orphans.length > 0) {
    findings.push({
      severity: "warn",
      message: `${orphans.length} orphan bridge-server process(es): ${orphans.join(", ")}`,
      fix: `These are from prior Claude sessions that died without cleanup. Run \`abg kill\` to reap them (now reaps orphans automatically).`,
      repair: async () => {
        // Re-classify instead of signalling the list from diagnosis.
        // `findOrphanBridgeServers` requires a dead-or-reparented
        // parent, so a pid that has since been re-adopted by a live
        // Claude session drops out here and is left running.
        const stillOrphaned = findOrphanBridgeServers(dir);
        if (stillOrphaned.length === 0) throw new Error("no orphans left to reap");
        const reaped: number[] = [];
        for (const orphanPid of stillOrphaned) {
          try {
            process.kill(orphanPid, "SIGTERM");
            reaped.push(orphanPid);
          } catch {
            /* already gone, or not ours to signal */
          }
        }
        if (reaped.length === 0) throw new Error("every orphan had already exited");
        return `sent SIGTERM to orphan bridge-server pid(s) ${reaped.join(", ")}`;
      },
    });
  }

  // ---- Ports actually in use ----
  const projectPorts = project?.ports;
  const candidates = new Set<number>();
  if (projectPorts) {
    candidates.add(projectPorts.codexWs);
    candidates.add(projectPorts.codexProxy);
    candidates.add(projectPorts.control);
  }
  candidates.add(ns.controlPort);
  for (const port of candidates) {
    const pids = findPidsByListenPort(port);
    if (pids.length === 0) continue;
    const pidsAlive = pids.filter(isPidAlive);
    if (pidsAlive.length > 0) {
      findings.push({
        severity: "info",
        message: `Port ${port}: pid(s) ${pidsAlive.join(", ")} listening`,
      });
    }
  }

  // ---- Pin-contract mode (legacy) ----
  const pin = (process.env.AGENTBRIDGE_PIN_CONTRACT ?? "off").toLowerCase();
  if (pin === "always" || pin === "once") {
    findings.push({
      severity: "warn",
      message: `AGENTBRIDGE_PIN_CONTRACT=${pin} - per-message contract reminder is enabled (legacy mode)`,
      fix: `If you've run \`abg init\` in this project, AGENTS.md already carries the contract. You can unset AGENTBRIDGE_PIN_CONTRACT for ~200 tokens / turn savings.`,
    });
  }

  // ---- Report ----
  console.log(applyFixes ? "AgentBridge doctor --fix\n" : "AgentBridge doctor\n");
  const repairable = findings.filter((f) => f.repair);
  for (const f of findings) {
    const tag = f.severity === "error" ? "ERROR" : f.severity === "warn" ? "WARN " : "ok   ";
    console.log(`[${tag}] ${f.message}`);
    if (f.fix) {
      for (const line of f.fix.split("\n")) {
        console.log(`        ${line}`);
      }
    }
    if (f.repair && !applyFixes) {
      console.log(`        \`abg doctor --fix\` can repair this automatically.`);
    }
  }

  const counts = {
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
  };

  // ---- Repairs ----
  // Run after the full report so the user can read what state was found
  // before seeing what changed. Each repair is independent; one failing
  // must not skip the rest, so failures are collected and printed
  // rather than thrown.
  let repaired = 0;
  let repairFailed = 0;
  if (applyFixes && repairable.length > 0) {
    console.log("\nRepairs");
    for (const f of repairable) {
      try {
        console.log(`  fixed   ${await f.repair!()}`);
        repaired++;
      } catch (err) {
        console.log(`  skipped ${f.message}`);
        console.log(`          ${err instanceof Error ? err.message : String(err)}`);
        repairFailed++;
      }
    }
  }

  console.log("");
  if (counts.error + counts.warn === 0) {
    console.log("All clear.");
    return;
  }

  console.log(`${counts.error} error(s), ${counts.warn} warning(s).`);
  if (applyFixes) {
    if (repairable.length === 0) {
      console.log("Nothing here is safely auto-repairable — the fixes above need a human decision.");
    } else {
      console.log(`${repaired} repaired, ${repairFailed} skipped. Rerun \`abg doctor\` to confirm.`);
    }
  } else if (repairable.length > 0) {
    console.log(`${repairable.length} of these can be repaired with \`abg doctor --fix\`.`);
  }
}
