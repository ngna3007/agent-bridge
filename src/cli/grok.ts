import { spawn } from "node:child_process";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";

/**
 * Start Grok Build attached to this project's bridge.
 *
 * Grok talks to a *leader* — a shared backend process that owns the
 * model connection and fans session updates out to every connected
 * client. `--leader-socket` decides which one. Pointing it at the
 * daemon puts AgentBridge in the middle of that connection: the daemon
 * forwards every frame to the real machine-wide leader untouched, and
 * reads the traffic on the way past.
 *
 * That is the same shape the Codex side has, and it is what buys Grok
 * the same behaviour: the daemon sees the prompt the human sent and the
 * response that closes it, so a turn boundary is observed rather than
 * guessed, and it can inject a message into the live session over a
 * second connection of its own.
 *
 * Notably absent, compared to what this file used to do: no
 * `AGENTBRIDGE_ACTIVE` / `AGENTBRIDGE_AGENT`. Grok no longer joins the
 * bus as an MCP frontend claiming a slot — it is a proxied agent, like
 * Codex, and the daemon speaks for it.
 *
 * Deliberately no role sync. Grok reads CLAUDE.md and AGENTS.md and has
 * no instruction file of its own (GROK.md is not read as of grok
 * 0.2.118), so there is nowhere to render a Grok role that Claude or
 * Codex would not also read.
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
  // The daemon owns the socket we are about to hand Grok, so it has to
  // be up *before* the TUI tries to connect — not merely eventually.
  //
  // `readiness: "health"` because `/readyz` reports the Codex
  // app-server's bootstrap, which has nothing to do with whether Grok can
  // work. Gating here on it would mean a machine with a broken or absent
  // Codex install can never start Grok, in a bridge whose whole claim is
  // that its agents are independent.
  await lifecycle.ensureRunning({ readiness: "health" });

  // A healthy daemon is not the same as a daemon owning this socket: one
  // started before this feature existed, or one whose `listen` failed,
  // is healthy without it. Grok would then connect to nothing and hang.
  // Wait for the daemon to report the socket bound, and if it never
  // does, say what to do rather than handing the failure to the TUI.
  //
  // Deliberately asked over `/healthz` rather than by connecting: the
  // adapter hands its one TUI slot to the first connection it sees, so a
  // connect-probe takes the slot the TUI is about to need and the launch
  // races its own probe's teardown for it.
  if (!(await lifecycle.waitForGrokProxy())) {
    console.error(`Error: the bridge is not listening on ${stateDir.grokLeaderSocket}.`);
    console.error("Run `abg kill` to restart the daemon, then try again.");
    console.error("If it persists, check `abg doctor` and the daemon log.");
    process.exit(1);
  }

  // `--leader-socket` is the one flag that decides which backend this
  // TUI talks to, and pointing it anywhere but the daemon means the
  // bridge sees nothing: no turn boundaries, no messages, no injection.
  // Honouring it would produce a plain `grok` wearing an `abg` name —
  // the failure would be silent and would look like the bridge being
  // broken. Overriding it would make the flag a lie. So: refuse, and say
  // which command does what.
  if (args.some((a) => a === "--leader-socket" || a.startsWith("--leader-socket="))) {
    console.error(
      "Error: --leader-socket is owned by AgentBridge; `abg grok` points Grok at this project's bridge.",
    );
    console.error("Run `grok` directly to choose your own leader.");
    process.exit(1);
  }
  const leaderArgs = ["--leader-socket", stateDir.grokLeaderSocket];

  // Grok loads Claude Code's plugin registry, so it spawns our MCP
  // server whether or not we want it to. `AGENTBRIDGE_ACTIVE` is the
  // gate that server checks before claiming a frontend slot — and an
  // inherited one (this command was very likely typed in a terminal
  // under `abg claude`) would have Grok's MCP child attach as Claude
  // and evict the real one. Clear both, explicitly.
  const env = { ...process.env };
  delete env.AGENTBRIDGE_ACTIVE;
  delete env.AGENTBRIDGE_AGENT;

  const child = spawn("grok", [...leaderArgs, ...args], {
    stdio: "inherit",
    env,
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
