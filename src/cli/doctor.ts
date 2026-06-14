/**
 * `abg doctor` - diagnose stuck or surprising state and suggest the
 * fix. Read-only: never modifies state. Output is a checklist of
 * concrete diagnostics plus, where useful, a copy-pasteable fix.
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
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config-service";
import {
  findPidsByListenPort,
  findOrphanBridgeServers,
  isPidAlive,
} from "../process-helpers";
import { resolveRuntimeNamespace } from "../runtime-namespace";

interface Finding {
  severity: "info" | "warn" | "error";
  message: string;
  fix?: string;
}

export async function runDoctor() {
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
          });
        }
      }
    } catch {
      /* ignore */
    }
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
      findings.push({
        severity: "warn",
        message: `Stale daemon.pid (process ${pid} is dead)`,
        fix: `Run \`abg kill\` to clean up. Then \`abg claude\` or \`abg codex\` to restart.`,
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
  console.log("AgentBridge doctor\n");
  for (const f of findings) {
    const tag = f.severity === "error" ? "ERROR" : f.severity === "warn" ? "WARN " : "ok   ";
    console.log(`[${tag}] ${f.message}`);
    if (f.fix) {
      for (const line of f.fix.split("\n")) {
        console.log(`        ${line}`);
      }
    }
  }
  const counts = {
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
  };
  console.log("");
  if (counts.error + counts.warn === 0) {
    console.log("All clear.");
  } else {
    console.log(`${counts.error} error(s), ${counts.warn} warning(s).`);
  }
}
