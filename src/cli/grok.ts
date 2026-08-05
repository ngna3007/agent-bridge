import { spawn } from "node:child_process";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";

/**
 * Start Grok Build attached to this project's bridge.
 *
 * There is no Grok-specific adapter and no MCP registration to do.
 * Grok reads Claude Code's plugin registry, so it already loads
 * AgentBridge's MCP server and its `reply` / `get_messages` tools —
 * `grok inspect` lists us among the plugins it loads. What it was
 * missing is two environment variables:
 *
 *   AGENTBRIDGE_ACTIVE=1   the gate `bridge.ts` gets before it will
 *                          claim a frontend slot. Without it a plain
 *                          `grok` self-exits, which is what we want:
 *                          only sessions launched through `abg` join
 *                          the bus. It is set here rather than baked
 *                          into an MCP entry for exactly that reason.
 *
 *   AGENTBRIDGE_AGENT=grok the identity the daemon keys its frontend
 *                          slot by. Without it Grok attaches as Claude
 *                          and the two evict each other, since Claude
 *                          is what every frontend was before 0.8.
 *
 * Grok spawns the MCP server as a child process, so both are inherited.
 *
 * Note this wires the *outbound* half only: Grok can send into the bus
 * and read from it. Waking a live Grok TUI with an inbound message is
 * the leader socket, which is separate work (docs/scaling-plan.md 4.1a).
 */
export async function runGrok(args: string[]) {
  const stateDir = new StateDirResolver();
  stateDir.ensure();
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  // Same as `abg claude`: an explicit launch clears a previous `abg
  // kill`, or the daemon would refuse to come back up.
  lifecycle.clearKilled();

  // Deliberately no role sync. Grok reads CLAUDE.md and AGENTS.md and
  // has no instruction file of its own (GROK.md is not read as of grok
  // 0.2.114), so there is nowhere to render a Grok role that Claude or
  // Codex would not also read. Until that is designed, Grok sees the
  // other two agents' roles and no role of its own.

  const child = spawn("grok", args, {
    stdio: "inherit",
    env: { ...process.env, AGENTBRIDGE_ACTIVE: "1", AGENTBRIDGE_AGENT: "grok" },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: grok not found in PATH.");
      console.error("Install Grok Build: curl -fsSL https://x.ai/cli/install.sh | bash");
      process.exit(1);
    }
    console.error(`Error starting Grok: ${err.message}`);
    process.exit(1);
  });
}
