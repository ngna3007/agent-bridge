import { execSync, execFileSync } from "node:child_process";
import { basename, relative } from "node:path";
import { ConfigService, DEFAULT_CONFIG } from "../config-service";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";
import { seedRoleFiles, syncRoleSections } from "../roles";
import { checkSetupLocation, computeProjectId, computeProjectPorts } from "../project-id";
import { homedir } from "node:os";

const MIN_CLAUDE_VERSION = "2.1.80";

export async function runInit() {
  console.log("AgentBridge Init\n");

  // Sanity check the location before doing anything destructive.
  const cwd = process.cwd();
  const refusal = checkSetupLocation(cwd, homedir());
  if (refusal?.kind === "unsafe-root") {
    console.error(`Error: refusing to init at "${refusal.dir}".`);
    console.error("");
    console.error("Initializing AgentBridge at your home directory or filesystem root would");
    console.error("force every project under it into the same AgentBridge namespace and");
    console.error("collide with whichever one you launch first. cd into a specific project");
    console.error("directory and run `abg init` there.");
    process.exit(1);
  }
  if (refusal?.kind === "nested") {
    console.error(`Error: an AgentBridge project already exists at "${refusal.existingRoot}".`);
    console.error("");
    console.error(`If you want to re-init that project, run \`abg init\` from there directly.`);
    console.error(`If you want a fresh project here, first remove the ancestor's .agentbridge/`);
    console.error(`directory.`);
    process.exit(1);
  }

  // Step 1: Check dependencies
  console.log("Checking dependencies...");
  checkBun();
  checkClaude();
  checkCodex();
  console.log("");

  performProjectSetup(cwd);

  console.log("Setup complete!\n");
  printCustomizationSummary(cwd);
  console.log("");
  console.log("Next steps:");
  console.log("  1. If Claude Code is already running, execute /reload-plugins in your session");
  console.log("  2. Start Claude Code:  abg claude");
  console.log("  3. Start Codex TUI:    abg codex");
  console.log("  4. Optional, anytime:  abg roles     # make each agent yours");
}

/**
 * The setup work itself: project config, collaboration sections, plugin
 * install. Shared by the explicit `abg init` command and the first-run
 * auto-setup offer, so the two can never drift into producing different
 * projects.
 *
 * Caller is responsible for `checkSetupLocation` and dependency checks —
 * they differ between the two entry points (init exits, auto-setup
 * declines silently).
 */
export function performProjectSetup(projectRoot: string): void {
  // Generate project config with per-project derived ports. The
  // .agentbridge/ directory acts as the project marker for the CLI's
  // namespace logic (project-id.ts), and the codex ports in
  // config.json must match the per-project derivation so the daemon
  // and the CLI agree on which sockets to use.
  console.log("Generating project config...");
  const configService = new ConfigService(projectRoot);
  const projectId = computeProjectId(projectRoot);
  const ports = computeProjectPorts(projectId);

  if (!configService.hasConfig()) {
    configService.save({
      ...DEFAULT_CONFIG,
      codex: {
        appPort: ports.codexWs,
        proxyPort: ports.codexProxy,
      },
    });
    console.log(`  Created: ${configService.configFilePath}`);
    console.log(`  Project id: ${projectId}`);
    console.log(`  Per-project ports: codex ${ports.codexWs} · proxy ${ports.codexProxy} · control ${ports.control}`);
  } else {
    console.log("  Project config already exists, skipping.");
    console.log(`  (Existing ports preserved; project id for namespacing: ${projectId})`);
  }
  console.log("");

  // Role files first: they are the source the sections render from.
  // Seeding never overwrites, so re-running setup after the user has
  // customized a role leaves their text alone.
  console.log("Writing role files...");
  for (const outcome of seedRoleFiles(projectRoot)) {
    const shown = relative(projectRoot, outcome.path);
    console.log(`  ${shown}: ${outcome.created ? "created with default role" : "already exists, left untouched"}`);
  }
  console.log("");

  console.log("Rendering collaboration sections...");
  for (const result of writeCollaborationSections(projectRoot)) {
    console.log(`  ${result}`);
  }
  console.log("");

  // Plugin install is best-effort: a project is still usable without
  // it (the user can run `abg dev` later), so a failure here must not
  // abort a setup that has already written the config.
  console.log("Installing AgentBridge plugin...");
  try {
    registerMarketplace(findPackageRoot());
    execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
      stdio: "inherit",
    });
    console.log("  Plugin installed successfully.");
  } catch {
    console.log("  Plugin install skipped (marketplace registration or install failed).");
    console.log("  You can install it later with:");
    console.log(`    abg dev   # registers marketplace and installs plugin`);
  }
  console.log("");
}

/**
 * Tell the user what they can now tune, and where. Printed once at the
 * end of setup — the moment they have the files in front of them and
 * before they have formed the belief that none of this is adjustable.
 */
export function printCustomizationSummary(projectRoot: string): void {
  const lines = [
    `What you can customize (relative to ${projectRoot}):`,
    "",
    "  .agentbridge/roles/claude.md         what Claude is told it is",
    "  .agentbridge/roles/codex.md          what Codex is told it is",
    "      Role, workflow, review discipline, message style — all of it is",
    "      plain prose and all of it is yours. The file body IS the role",
    "      text; there is no format to get right.",
    "        abg roles              see what each agent is running on",
    "        abg roles edit codex   rewrite Codex's role in $EDITOR",
    "      Edit a file and restart that agent; `abg claude` / `abg codex`",
    "      re-render the matching section of CLAUDE.md / AGENTS.md on every",
    "      launch. Delete a file to get the built-in default back.",
    "",
    "  .agentbridge/config.json",
    "      codex.appPort / codex.proxyPort      the ports this project uses",
    "      turnCoordination.attentionWindowSeconds",
    "                                           how long [STATUS] stays quiet",
    "                                           after a [REPLY] (default 15s)",
    "      idleShutdownSeconds                  daemon exit delay when no client",
    "                                           is attached (default 30s)",
    "",
    "  CLAUDE.md · AGENTS.md",
    "      Text between the <!-- AgentBridge:start/end --> markers is",
    "      RENDERED OUTPUT — edit the role files above instead, or your",
    "      changes are overwritten on the next launch. Anything outside",
    "      the markers is yours and is never touched.",
    "",
    "  Environment variables (override everything above):",
    "      AGENTBRIDGE_FILTER_MODE=full         forward every Codex message",
    "                                           instead of routing by marker",
    "      AGENTBRIDGE_MODE=pull                deliver via get_messages instead",
    "                                           of push notifications",
    "      AGENTBRIDGE_ATTENTION_WINDOW_MS, AGENTBRIDGE_IDLE_SHUTDOWN_MS,",
    "      AGENTBRIDGE_MAX_BUFFERED_MESSAGES, AGENTBRIDGE_STATE_DIR",
    "      Full list: README.md → Configuration",
    "",
    "  `abg doctor` checks all of the above for drift.",
  ];
  for (const line of lines) console.log(line);
}

function checkBun() {
  try {
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    console.log(`  bun: ${version}`);
  } catch {
    console.error("  ERROR: bun not found in PATH.");
    console.error("  Install Bun: https://bun.sh");
    process.exit(1);
  }
}

function checkClaude() {
  try {
    const versionOutput = execSync("claude --version", { encoding: "utf-8" }).trim();
    // Extract version number (may be in format "claude v2.1.80" or just "2.1.80")
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      const version = match[1];
      console.log(`  claude: ${version}`);
      if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
        console.error(`  ERROR: Claude Code version ${version} is too old.`);
        console.error(`  Channels require >= ${MIN_CLAUDE_VERSION}.`);
        console.error("  Update: npm update -g @anthropic-ai/claude-code");
        process.exit(1);
      }
    } else {
      console.log(`  claude: ${versionOutput} (version check skipped)`);
    }
  } catch {
    console.error("  ERROR: claude not found in PATH.");
    console.error("  Install Claude Code: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
}

function checkCodex() {
  try {
    const version = execSync("codex --version", { encoding: "utf-8" }).trim();
    console.log(`  codex: ${version}`);
  } catch {
    console.error("  ERROR: codex not found in PATH.");
    console.error("  Install Codex: https://github.com/openai/codex");
    process.exit(1);
  }
}

/** Compare semver strings. Returns -1, 0, or 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Render the per-agent role files into CLAUDE.md / AGENTS.md and
 * return one human-readable status line per file.
 *
 * The section content comes from `.agentbridge/roles/<agent>.md`, not
 * from a constant — see `src/roles.ts`. Callers that have not seeded
 * those files yet still get the built-in defaults, so this stays safe
 * to call on a project created by an older version.
 */
export function writeCollaborationSections(projectRoot: string): string[] {
  return syncRoleSections(projectRoot).map((outcome) => {
    const name = basename(outcome.file);
    switch (outcome.status) {
      case "skipped":
        return `${name}: skipped — ${outcome.detail}`;
      case "unchanged":
        return `${name}: unchanged (section already up to date)`;
      case "created":
        return `${name}: created with collaboration section`;
      case "updated":
        return `${name}: updated collaboration section`;
      case "appended":
        return `${name}: appended collaboration section`;
    }
  });
}

export { compareVersions };
