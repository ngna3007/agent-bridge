import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";
import { UserPrefsService } from "../user-prefs";
import { arrowPicker } from "./prompt";

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
