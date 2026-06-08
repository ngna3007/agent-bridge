import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";
import { UserPrefsService } from "../user-prefs";
import { arrowPicker } from "./prompt";
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

  // First-run intro screen. Shows the AgentBridge logo and a short
  // description; auto-wires ~/.claude/settings.json for the statusbar.
  // Esc anywhere in the screen aborts the whole `abg claude` command.
  await maybeShowIntro(stateDir);

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
 * AgentBridge ASCII logo (slant figlet style). Six lines of plain
 * ASCII so it renders identically across terminals.
 */
const LOGO = [
  "    ___                  __     ____       _      __         ",
  "   /   |  ____ ____ ___  / /_   / __ )_____(_)____/ /___ ____ ",
  "  / /| | / __ `/ _ \\__ \\/ __/  / __  / ___/ // __  / __ `/ _ \\",
  " / ___ |/ /_/ /  __/__/ / /_   / /_/ / /  / // /_/ / /_/ /  __/",
  "/_/  |_|\\__, /\\___/____/\\__/  /_____/_/  /_/ \\__,_/\\__, /\\___/ ",
  "       /____/                                     /____/      ",
].join("\n");

/**
 * Show the AgentBridge intro screen the first time `abg claude` runs
 * for this user. Persists `introAcknowledged` so it never re-displays.
 * Auto-wires the user's ~/.claude/settings.json to surface our status
 * tag in their statusbar (chained onto whatever statusLine command
 * already exists, no overwrite).
 *
 * Skipped silently in non-interactive environments; we still record
 * the acknowledgement and still attempt the wire so a one-shot
 * headless run gets a working statusbar too.
 */
async function maybeShowIntro(stateDir: StateDirResolver): Promise<void> {
  const prefs = new UserPrefsService(stateDir);
  if (prefs.hasAcknowledgedIntro()) return;

  const statusFilePath = `${stateDir.dir}/status.line`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // No TTY -> can't show the screen. Wire silently and continue.
    wireStatusLine({ statusFilePath });
    prefs.update({ introAcknowledged: true });
    return;
  }

  // Logo lives above the picker so its full width renders without
  // the picker's two-space indent or single-line title constraint.
  // The picker's ephemeral cleanup only erases its own rendered
  // region, so the logo persists in scrollback once shown.
  process.stdout.write("\n" + LOGO + "\n");

  const body = [
    "Connects Claude Code and Codex so they can collaborate on the",
    "same task. Use the reply / get_messages tools to send messages",
    "between them.",
    "",
    "Recommended companion tools:",
    "  caveman   Terse Claude replies. 30-60% fewer tokens per turn.",
    "  rtk       Shrinks dev-command output before Claude reads it.",
    "",
    "AgentBridge will add a one-line statusbar entry to your Claude",
    "Code settings so [BRIDGE READY] / [CODEX READY] etc. show at the",
    "bottom edge. Existing statusLine entries (e.g. caveman) are kept.",
  ].join("\n");

  const choice = await arrowPicker<"continue">({
    title: "Welcome to AgentBridge",
    example: body,
    options: [{ value: "continue", label: "Got it - continue" }],
    defaultIndex: 0,
  });

  if (choice === null) {
    // Esc - exit cleanly without persisting or launching Claude.
    process.exit(0);
  }

  wireStatusLine({ statusFilePath });
  prefs.update({ introAcknowledged: true });
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
