import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";
import { UserPrefsService } from "../user-prefs";
import { arrowPicker } from "./prompt";
import { detectRtk, detectCaveman } from "./tool-detection";
import { wireStatusLine } from "../settings-wire";

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

export async function runClaude(args: string[]) {
  // Check for owned flag conflicts
  checkOwnedFlagConflicts(args, "agentbridge claude", OWNED_FLAGS);

  const stateDir = new StateDirResolver();
  stateDir.ensure();
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  lifecycle.clearKilled();

  // First-run onboarding. Three prompts in sequence (statusLine,
  // caveman, rtk). Pressing Esc in any prompt aborts the process
  // entirely (like Ctrl-C): we exit silently without persisting and
  // without launching Claude. Re-running `abg claude` re-prompts.
  await maybeAskStatusLineMode(stateDir);
  await maybeRunOnboardingWizard(stateDir);

  // Channel entry format: "server:<mcp-server-name>" for MCP-based channels,
  // or "plugin:<plugin>@<marketplace>" for plugin-based channels.
  // AgentBridge is installed as a plugin, so use the plugin channel format.
  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  // Only use --dangerously-load-development-channels for now.
  // --channels checks the approved allowlist (Anthropic-curated) and fails
  // for custom plugins. The dev flag bypasses this per-entry.
  // Once published to the official marketplace, switch to --channels.
  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...args,
  ];

  // AGENTBRIDGE_ACTIVE is the opt-in gate read by bridge.ts. Only
  // claude sessions launched via `abg claude` get it; a plain `claude`
  // or `claude -c` still loads the agentbridge plugin (Claude can't
  // know to skip it) but its bridge-server.js will self-exit before
  // claiming the daemon's single Claude slot. Without this gate any
  // background claude session would silently hold the slot and block
  // future `abg claude` launches.
  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: { ...process.env, AGENTBRIDGE_ACTIVE: "1" },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: claude not found in PATH.");
      console.error("Install Claude Code: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.error(`Error starting Claude Code: ${err.message}`);
    process.exit(1);
  });
}

/**
 * First-run only: ask whether AgentBridge should auto-wire the user's
 * Claude Code statusLine command to show the bridge's current state
 * (e.g. "[CODEX]" or "[OFFLINE]") at the bottom edge of the TUI. The
 * status.line file is always written; this prompt only controls
 * whether settings.json gets patched for the user.
 */
async function maybeAskStatusLineMode(stateDir: StateDirResolver): Promise<void> {
  const prefs = new UserPrefsService(stateDir);
  if (prefs.hasBeenAskedStatusLine()) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    prefs.update({ statusLineAsked: true });
    return;
  }

  const statusFilePath = `${stateDir.dir}/status.line`;
  const example = [
    "AgentBridge writes the current link state to:",
    `  ${statusFilePath}`,
    "",
    "Wiring it into Claude Code's statusLine shows it at the bottom",
    "edge, e.g. [CODEX] when Codex is connected, [OFFLINE] when not.",
  ].join("\n");

  const choice = await arrowPicker<"wire" | "manual" | "skip">({
    title: "Show bridge status in Claude Code's statusbar?",
    example,
    options: [
      { value: "wire", label: "Edit settings.json for me now" },
      { value: "manual", label: "I will set it up myself" },
      { value: "skip", label: "Skip" },
    ],
    defaultIndex: 0,
  });

  if (choice === null) {
    // Esc - exit cleanly without persisting anything or launching
    // Claude. The user effectively backed out of `abg claude`.
    process.exit(0);
  }

  prefs.update({ statusLineAsked: true });

  if (choice === "wire") {
    // Best-effort: wire settings.json silently. If it conflicts or
    // errors, status.line still gets written; user just won't see
    // it in the TUI statusbar until they configure manually.
    wireStatusLine({ statusFilePath });
  }
}

/**
 * Walk the user through opt-in prompts for our recommended companion
 * tools. Each tool's prompt runs at most once per user (persisted in
 * user-prefs.json). The wizard never installs or modifies anything;
 * it records the user's preference and prints install pointers.
 *
 * Tools covered:
 *   - caveman: a Claude Code skill that compresses Claude's responses.
 *   - rtk: Rust Token Killer, a CLI proxy that rewrites verbose dev
 *     commands into token-cheap variants.
 */
async function maybeRunOnboardingWizard(stateDir: StateDirResolver): Promise<void> {
  const prefs = new UserPrefsService(stateDir);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive: mark both as asked so we never block startup
    // and stop ourselves from re-asking on every headless launch.
    prefs.update({ cavemanAsked: true, rtkAsked: true });
    return;
  }

  if (!prefs.hasBeenAskedCaveman()) await askCaveman(prefs);
  if (!prefs.hasBeenAskedRtk()) await askRtk(prefs);
}

async function askCaveman(prefs: UserPrefsService): Promise<void> {
  const status = detectCaveman();
  const example = [
    "Claude Code skill. Replies in short caveman style; 30-60% fewer",
    "tokens per turn. Code, commits, security warnings stay normal.",
    `Local: ${status.installed ? "installed" : "not installed"}. Install via Claude Code marketplace.`,
  ].join("\n");

  const choice = await arrowPicker<"opt-in" | "skip">({
    title: "Use caveman reply style?",
    example,
    options: [
      { value: "opt-in", label: "Yes" },
      { value: "skip", label: "Skip" },
    ],
    defaultIndex: status.installed ? 0 : 1,
  });

  if (choice === null) {
    process.exit(0);
  }
  const optIn = choice === "opt-in";
  prefs.update({ cavemanAsked: true, cavemanOptIn: optIn });
}

async function askRtk(prefs: UserPrefsService): Promise<void> {
  const status = detectRtk();
  const detectedLine = status.installed
    ? `installed${status.version ? ` (${status.version})` : ""}`
    : "not installed";
  const example = [
    "Shell proxy. Shrinks command output before Claude reads it",
    "(e.g. `git log` 1000 lines becomes 20). 60-90% token cut on",
    "dev work. Install: `cargo install rtk` + shell hook.",
    `Local: ${detectedLine}.`,
  ].join("\n");

  const choice = await arrowPicker<"opt-in" | "skip">({
    title: "Use rtk to shrink dev-command output?",
    example,
    options: [
      { value: "opt-in", label: "Yes" },
      { value: "skip", label: "Skip" },
    ],
    defaultIndex: status.installed ? 0 : 1,
  });

  if (choice === null) {
    process.exit(0);
  }
  const optIn = choice === "opt-in";
  prefs.update({ rtkAsked: true, rtkOptIn: optIn });
}

/**
 * Check if user passed any AgentBridge-owned flags.
 * Hard error if they did - mixed flag state is unpredictable.
 */
export function checkOwnedFlagConflicts(
  args: string[],
  commandName: string,
  ownedFlags: string[],
) {
  for (const flag of ownedFlags) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by ${commandName}.`);
      console.error("");
      console.error("AgentBridge automatically injects these flags:");
      for (const f of ownedFlags) {
        console.error(`  ${f}`);
      }
      console.error("");
      const nativeCmd = commandName.includes("codex") ? "codex" : "claude";
      console.error("If you need full control over these flags, use the native command directly:");
      console.error(`  ${nativeCmd} [your flags here]`);
      process.exit(1);
    }
  }
}
