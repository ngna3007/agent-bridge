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

import { resolveProject, applyProjectEnv } from "./project-id";
import { StateDirResolver } from "./state-dir";

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
  // init/dev/--help/--version run in "no project yet" mode; honoring
  // an ancestor marker would create surprising port assignments
  // during onboarding. Apply the namespace only for the runtime
  // commands that actually launch or stop the daemon.
  const namespaced = new Set(["claude", "codex", "kill"]);
  if (!namespaced.has(cmd)) return;

  const project = resolveProject();
  if (!project) return; // single-instance fallback - historical behavior

  // Use the platform-default state dir as the base (the resolver
  // takes the env var into account, but with no env yet it returns
  // the platform default). applyProjectEnv then nests under it.
  const baseStateDir = new StateDirResolver().dir;
  applyProjectEnv(project, baseStateDir);
}

async function main() {
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
      await runKill();
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
  init              Install plugin, check dependencies, generate project config
  dev               Register local marketplace + install plugin (for local dev)
  claude [args...]  Start Claude Code with push channel enabled
  codex [args...]   Start Codex TUI connected to AgentBridge daemon
  kill              Force kill all AgentBridge processes

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  abg init                     # First-time setup
  abg claude                   # Start Claude Code
  abg claude --resume          # Start Claude Code and resume session
  abg codex                    # Start Codex TUI
  abg codex --model o3         # Start Codex with specific model
  abg kill                     # Emergency: kill all processes
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
