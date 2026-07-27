#!/usr/bin/env bun

/**
 * AgentBridge CLI
 *
 * Commands:
 *   agentbridge init        — Install plugin, check deps, generate project config
 *   agentbridge dev         — Register local marketplace + install plugin for local dev
 *   agentbridge claude      — Start Claude Code with push channel flags
 *   agentbridge codex       — Start Codex TUI connected to daemon
 *   agentbridge kill        — Force kill all AgentBridge processes
 */

import { resolveRuntimeNamespace } from "./runtime-namespace";

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Marketplace name constant (shared with plugin)
export const MARKETPLACE_NAME = "agentbridge";
export const PLUGIN_NAME = "agentbridge";

/**
 * Per-project namespacing: when the cwd is inside a directory that
 * has a `.agentbridge/` marker (created by `abg init`), derive ports
 * and state-dir suffix from the project root path so multiple
 * projects can run side-by-side on the same machine. Skipped for
 * `init`, `dev`, and metadata commands - they should not pick up a
 * project namespace from a stale ancestor `.agentbridge/`.
 */
function maybeApplyProjectNamespace(cmd: string | undefined): void {
  if (!cmd) return;
  // init / dev / --help / --version run in "no project yet" mode -
  // their decisions don't depend on a daemon, so we leave env alone.
  // status / doctor / projects are read-only diagnostics; they call
  // resolveRuntimeNamespace themselves with mutateEnv:false to read
  // the right state dir without affecting downstream code.
  // claude / codex / kill all spawn or talk to the daemon, so they
  // need the per-project env vars applied here.
  const namespaced = new Set(["claude", "codex", "kill"]);
  if (!namespaced.has(cmd)) return;

  const ns = resolveRuntimeNamespace({ mutateEnv: true });
  if (!ns.project) return; // single-instance fallback - historical behavior

  // One-line startup banner so the user can see at a glance which
  // project this terminal is talking to. Stays out of automation
  // (non-TTY skipped).
  if (process.stdout.isTTY) {
    const p = ns.project;
    process.stderr.write(
      `[abg] project ${p.projectId} · ports ${p.ports.codexWs}/${p.ports.codexProxy}/${p.ports.control} · ${p.rootPath}\n`,
    );
  }
}

async function main() {
  // First-run setup offer, before the namespace is resolved. A project
  // created here must be visible to maybeApplyProjectNamespace below,
  // otherwise the user answers "yes" and still gets fallback ports for
  // the rest of this session.
  const { maybeOfferSetup } = await import("./cli/auto-setup");
  await maybeOfferSetup(command);

  maybeApplyProjectNamespace(command);

  switch (command) {
    case "init":
      const { runInit } = await import("./cli/init");
      await runInit();
      break;
    case "dev":
      const { runDev } = await import("./cli/dev");
      await runDev();
      break;
    case "claude":
      const { runClaude } = await import("./cli/claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./cli/codex");
      await runCodex(restArgs);
      break;
    case "kill":
      const { runKill } = await import("./cli/kill");
      await runKill(restArgs);
      break;
    case "status":
      const { runStatus } = await import("./cli/status");
      await runStatus();
      break;
    case "projects":
      const { runProjects } = await import("./cli/projects");
      await runProjects();
      break;
    case "doctor":
      const { runDoctor } = await import("./cli/doctor");
      await runDoctor();
      break;
    case "roles":
      const { runRoles, printRolesHelp } = await import("./cli/roles-cmd");
      if (restArgs[0] === "--help" || restArgs[0] === "-h") {
        printRolesHelp();
      } else {
        await runRoles(restArgs);
      }
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "agentbridge --help" (or "abg --help") for usage.`);
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
AgentBridge — Multi-agent collaboration bridge

Usage:
  agentbridge <command> [args...]
  abg <command> [args...]

Commands:
  init              First-time per-project setup: install plugin, check deps,
                    generate .agentbridge/config.json with per-project ports
  dev               Register local marketplace + install plugin (for local dev)
  claude [args...]  Start Claude Code with push channel enabled
  codex [args...]   Start Codex TUI connected to AgentBridge daemon
  kill [--all]      Stop daemon + managed Codex TUI for the current project
                    (or every project when --all is passed)
  roles [sub]       Show or edit what each agent is told it is
                    (list | edit <agent> | apply | reset <agent> | path <agent>)
  status            Report project info, daemon state, ports (read-only)
  projects          List every project state dir + its daemon state
  doctor            Diagnose stuck or surprising state, suggest fixes

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Multi-project:
  Each project gets its own port triple (derived from the project path)
  and its own daemon slot. \`abg claude\` / \`abg codex\` offer to set the
  project up on first run in an unconfigured directory; \`abg init\` does
  the same thing explicitly. Declining, or running non-interactively,
  falls back to the shared single-instance mode (ports 4500/4501/4502).
  Set AGENTBRIDGE_AUTO_SETUP=0 to suppress the offer entirely.

Agent roles:
  Setup seeds .agentbridge/roles/claude.md and .agentbridge/roles/codex.md
  with the built-in defaults and never overwrites them again. The file body
  is the role text — plain prose, no format. Edit one and restart that
  agent; \`abg claude\` / \`abg codex\` re-render the matching section of
  CLAUDE.md / AGENTS.md on launch. \`abg roles\` shows the current state.

Examples:
  abg init                     # First-time setup, in this project root
  abg claude                   # Start Claude Code in this project
  abg claude --resume          # ... and resume the last session
  abg codex                    # Start Codex TUI
  abg codex --model o3         # ... with a specific model
  abg roles                    # See what each agent is told it is
  abg roles edit codex         # Rewrite Codex's role in \$EDITOR
  abg status                   # See which project + daemon is active here
  abg kill                     # Stop the daemon for this project
`.trim());
}

function printVersion() {
  try {
    const pkg = require("../package.json");
    console.log(`agentbridge v${pkg.version}`);
  } catch {
    console.log("agentbridge (version unknown)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
