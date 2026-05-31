import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";
import { UserPrefsService } from "../user-prefs";
import { arrowPicker } from "./prompt";
import { detectRtk, detectCaveman, type ToolStatus } from "./tool-detection";

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

  // First-run prompt: ask whether lifecycle events should route to a
  // status.line file (zero token cost) or remain in Claude's MCP channel.
  // Skipped silently in non-interactive environments - the default applies.
  await maybeAskStatusLineMode(stateDir);

  // First-run onboarding for companion tools (caveman, rtk). Each one
  // is independent and self-gating: already-answered prompts are skipped.
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

  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: process.env,
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
 * First-run only: ask the user whether lifecycle events (kickoff,
 * disconnect, reconnect) should be routed to the status.line file
 * instead of Claude's MCP channel. The choice is persisted so we never
 * re-ask. Skipped automatically when stdin/stdout are not a TTY.
 */
async function maybeAskStatusLineMode(stateDir: StateDirResolver): Promise<void> {
  const prefs = new UserPrefsService(stateDir);
  if (prefs.hasBeenAskedStatusLine()) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // No way to ask - remember that we tried so we don't keep checking,
    // and leave the mode at its default ("channel"). Users running
    // headlessly can set the mode explicitly via the prefs file.
    prefs.update({ statusLineAsked: true });
    return;
  }

  const example = [
    "If you enable statusLine, lifecycle events show up here instead",
    "of in Claude's context:",
    "",
    "  $ cat ~/.local/state/agentbridge/status.line",
    "  2026-01-01T12:34:56Z\t🤝 Codex has connected via AgentBridge.",
    "",
    "IMPORTANT: this only writes the status file. To actually see it,",
    "you must manually add a statusLine command to your Claude Code",
    "settings at ~/.claude/settings.json:",
    "",
    '  "statusLine": {',
    '    "command": "cat ~/.local/state/agentbridge/status.line"',
    "  }",
    "",
    "AgentBridge will NOT edit settings.json for you. If you enable",
    "this and skip the settings.json edit, you will simply stop seeing",
    "routine connect/disconnect events (urgent events like \"bridge",
    "evicted\" still reach Claude either way).",
  ].join("\n");

  const choice = await arrowPicker<"line" | "channel">({
    title: "Route AgentBridge lifecycle events to a status.line file?",
    example,
    options: [
      {
        value: "line",
        label: "Yes, use status.line",
        description: "saves tokens. requires one-time settings.json edit",
      },
      {
        value: "channel",
        label: "No, keep events in Claude's channel",
        description: "current behavior. no extra setup",
      },
    ],
    defaultIndex: 0,
  });

  if (choice === null) {
    // Cancelled (Esc/Ctrl-C) - don't persist. Will re-ask next run.
    console.error("[agentbridge] No choice made - will ask again next launch.");
    return;
  }

  prefs.update({ statusLineMode: choice, statusLineAsked: true });
  if (choice === "line") {
    console.error("[agentbridge] statusLine mode enabled. Status file: " + stateDir.dir + "/status.line");
    console.error("[agentbridge] REMINDER: add the statusLine command to ~/.claude/settings.json yourself, or you will not see routine lifecycle events.");
    console.error("[agentbridge] To reverse this choice later, delete the 'statusLineMode' key in " + stateDir.dir + "/user-prefs.json");
  } else {
    console.error("[agentbridge] Keeping events in Claude's channel (default behavior).");
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

  if (!prefs.hasBeenAskedCaveman()) {
    await askCaveman(prefs);
  }
  if (!prefs.hasBeenAskedRtk()) {
    await askRtk(prefs);
  }
}

async function askCaveman(prefs: UserPrefsService): Promise<void> {
  const status = detectCaveman();
  const example = renderToolExample({
    name: "caveman",
    summary: "Claude Code skill that compresses Claude's replies to a terse, fragment-style \"smart caveman\" register. Code and commit messages are exempt.",
    benefit: "Big cut in output tokens per turn (often 30-60%) without losing technical substance.",
    installHint: "Install via the Claude Code plugin marketplace, then enable in ~/.claude/settings.json under \"skills\".",
    status,
  });

  const choice = await arrowPicker<"opt-in" | "skip">({
    title: "Enable caveman mode for Claude Code?",
    example,
    options: [
      { value: "opt-in", label: "Yes, I want caveman", description: status.installed ? "already installed, just enable in settings" : "not installed yet, AgentBridge will print pointers" },
      { value: "skip", label: "No, skip for now", description: "you can change this later in user-prefs.json" },
    ],
    defaultIndex: status.installed ? 0 : 1,
  });

  if (choice === null) {
    console.error("[agentbridge] caveman: no choice made, will ask again next launch.");
    return;
  }
  const optIn = choice === "opt-in";
  prefs.update({ cavemanAsked: true, cavemanOptIn: optIn });
  if (optIn) {
    if (status.installed) {
      console.error(`[agentbridge] caveman: detected at ${status.path}. Enable it in ~/.claude/settings.json under "skills" if not already active.`);
    } else {
      console.error("[agentbridge] caveman: not detected. Install via the Claude Code plugin marketplace, then re-run for it to take effect.");
    }
  } else {
    console.error("[agentbridge] caveman: skipped.");
  }
}

async function askRtk(prefs: UserPrefsService): Promise<void> {
  const status = detectRtk();
  const example = renderToolExample({
    name: "rtk",
    summary: "Rust Token Killer is a CLI proxy that rewrites chatty dev commands (git, npm, etc.) into token-cheap output equivalents.",
    benefit: "60-90% token savings on routine dev operations. Transparent via a shell hook: `git status` becomes `rtk git status` automatically.",
    installHint: "See https://github.com/anthropic-experimental/rtk (cargo install rtk). Beware of the name collision with reachingforthejack/rtk (Rust Type Kit).",
    status,
  });

  const choice = await arrowPicker<"opt-in" | "skip">({
    title: "Enable rtk (Rust Token Killer) integration?",
    example,
    options: [
      { value: "opt-in", label: "Yes, I want rtk", description: status.installed ? `detected ${status.version ?? "(version unknown)"}` : "not installed yet, AgentBridge will print pointers" },
      { value: "skip", label: "No, skip for now", description: "you can change this later in user-prefs.json" },
    ],
    defaultIndex: status.installed ? 0 : 1,
  });

  if (choice === null) {
    console.error("[agentbridge] rtk: no choice made, will ask again next launch.");
    return;
  }
  const optIn = choice === "opt-in";
  prefs.update({ rtkAsked: true, rtkOptIn: optIn });
  if (optIn) {
    if (status.installed) {
      console.error(`[agentbridge] rtk: detected at ${status.path} (${status.version}). Hook it into your shell so it auto-rewrites commands.`);
    } else {
      console.error("[agentbridge] rtk: not detected on PATH. Install the real rtk (cargo install rtk) and re-run.");
      if (status.note) console.error(`[agentbridge] rtk: detection note: ${status.note}`);
    }
  } else {
    console.error("[agentbridge] rtk: skipped.");
  }
}

interface ToolExampleInput {
  name: string;
  summary: string;
  benefit: string;
  installHint: string;
  status: ToolStatus;
}

function renderToolExample(input: ToolExampleInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  ${input.summary}`);
  lines.push("");
  lines.push(`  Benefit: ${input.benefit}`);
  lines.push("");
  lines.push(`  Install / enable: ${input.installHint}`);
  lines.push("");
  if (input.status.installed) {
    lines.push(`  Detected: yes${input.status.path ? ` at ${input.status.path}` : ""}`);
    if (input.status.version) lines.push(`  Version:  ${input.status.version}`);
  } else {
    lines.push("  Detected: no");
    if (input.status.note) lines.push(`  Note:     ${input.status.note}`);
  }
  lines.push("");
  lines.push("AgentBridge will NOT install or auto-configure this for you;");
  lines.push("opting in only records your preference and prints pointers.");
  return lines.join("\n");
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
