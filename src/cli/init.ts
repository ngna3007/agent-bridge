import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigService, DEFAULT_CONFIG } from "../config-service";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";
import { upsertMarkedSection } from "../marker-section";
import {
  MARKER_ID,
  CLAUDE_MD_SECTION,
  AGENTS_MD_SECTION,
} from "../collaboration-content";
import { computeProjectId, computeProjectPorts, findProjectRoot } from "../project-id";
import { homedir } from "node:os";
import { dirname } from "node:path";

const MIN_CLAUDE_VERSION = "2.1.80";

export async function runInit() {
  console.log("AgentBridge Init\n");

  // Sanity check the location before doing anything destructive.
  // Running `abg init` in $HOME or `/` creates an ancestor marker
  // that would namespace EVERY subdir under it, which is almost
  // certainly not what the user wants - refuse loudly so they don't
  // have to debug it later.
  const cwd = process.cwd();
  const home = homedir();
  if (cwd === home || cwd === dirname(home) || cwd === "/") {
    console.error(`Error: refusing to init at "${cwd}".`);
    console.error("");
    console.error("Initializing AgentBridge at your home directory or filesystem root would");
    console.error("force every project under it into the same AgentBridge namespace and");
    console.error("collide with whichever one you launch first. cd into a specific project");
    console.error("directory and run `abg init` there.");
    process.exit(1);
  }

  // Refuse to nest a project marker under an existing one. Picking
  // the closest ancestor (current findProjectRoot behavior) handles
  // a stale subdir gracefully, but creating a second .agentbridge/
  // inside an existing project would split the namespace and is
  // never useful.
  const existingAncestor = findProjectRoot(cwd);
  if (existingAncestor && existingAncestor !== cwd) {
    console.error(`Error: an AgentBridge project already exists at "${existingAncestor}".`);
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

  // Step 2: Generate project config with per-project derived ports.
  // The .agentbridge/ directory acts as the project marker for the
  // CLI's namespace logic (project-id.ts), and the codex ports in
  // config.json must match the per-project derivation so the daemon
  // and the CLI agree on which sockets to use.
  console.log("Generating project config...");
  const configService = new ConfigService();
  const projectRoot = process.cwd();
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

  // Step 3: Write collaboration sections to CLAUDE.md and AGENTS.md
  console.log("Writing collaboration sections...");
  const collabResults = writeCollaborationSections(projectRoot);
  for (const result of collabResults) {
    console.log(`  ${result}`);
  }
  console.log("");

  // Step 4: Register marketplace + install plugin (best-effort)
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

  // Step 5: Done
  console.log("Setup complete!\n");
  console.log("Next steps:");
  console.log("  1. If Claude Code is already running, execute /reload-plugins in your session");
  console.log("  2. Start Claude Code:  agentbridge claude");
  console.log("  3. Start Codex TUI:    agentbridge codex");
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
 * Write or update AgentBridge collaboration sections in CLAUDE.md and AGENTS.md.
 * Returns human-readable status lines for each file.
 */
export function writeCollaborationSections(projectRoot: string): string[] {
  const results: string[] = [];

  const files: Array<{ name: string; path: string; section: string }> = [
    { name: "CLAUDE.md", path: join(projectRoot, "CLAUDE.md"), section: CLAUDE_MD_SECTION },
    { name: "AGENTS.md", path: join(projectRoot, "AGENTS.md"), section: AGENTS_MD_SECTION },
  ];

  for (const { name, path, section } of files) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf-8");
    } catch {
      // File doesn't exist — will be created
    }

    let updated: string;
    try {
      updated = upsertMarkedSection(existing, MARKER_ID, section);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${name}: skipped — ${msg}`);
      continue;
    }

    if (updated === existing) {
      results.push(`${name}: unchanged (section already up to date)`);
      continue;
    }

    writeFileSync(path, updated, "utf-8");
    if (existing === "") {
      results.push(`${name}: created with collaboration section`);
    } else if (existing.includes(`<!-- ${MARKER_ID}:start -->`)) {
      results.push(`${name}: updated collaboration section`);
    } else {
      results.push(`${name}: appended collaboration section`);
    }
  }

  return results;
}

export { compareVersions };
