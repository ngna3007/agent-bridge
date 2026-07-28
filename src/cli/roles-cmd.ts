/**
 * `abg roles` — see and change what each agent is told it is.
 *
 * The role files are plain markdown in the project, so everything here
 * is reachable with an editor and `rm`. The command exists because
 * "which file, is mine live, did I break routing" are questions the
 * filesystem answers badly, and because `abg roles edit codex` is a
 * shorter path to a customized agent than reading the docs first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { createInterface } from "node:readline";
import { findProjectRoot } from "../project-id";
import { warnOnMissingRoutingMarkers } from "./role-sync";
import {
  ROLE_AGENTS,
  RoleFileError,
  missingRoutingMarkers,
  readRoleText,
  roleFilePath,
  seedRoleFiles,
  seededRoleText,
  syncRoleSections,
  writeDefaultRoleFile,
  type RoleAgent,
} from "../roles";

export async function runRoles(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error("Not inside an AgentBridge project (no .agentbridge/ marker here or above).");
    console.error("");
    console.error("Roles are per-project. Run `abg init` here first, or cd into a project.");
    process.exit(1);
  }

  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "list":
      listRoles(projectRoot);
      return;
    case "path":
      console.log(roleFilePath(projectRoot, requireAgent(rest[0])));
      return;
    case "edit":
      await editRole(projectRoot, requireAgent(rest[0]));
      return;
    case "reset":
      await resetRole(projectRoot, requireAgent(rest[0]), rest.includes("--force"));
      return;
    case "apply":
      applyRoles(projectRoot);
      return;
    default:
      console.error(`Unknown subcommand: roles ${sub}`);
      printRolesHelp();
      process.exit(1);
  }
}

export function printRolesHelp(): void {
  console.log(`
Usage:
  abg roles                    Show each agent's role file and whether it is live
  abg roles edit <agent>       Open the role file in $EDITOR, then re-render
  abg roles apply              Re-render CLAUDE.md / AGENTS.md from the role files
  abg roles reset <agent>      Restore the built-in default role (destructive)
  abg roles path <agent>       Print the role file path (for scripting)

  <agent> is one of: ${ROLE_AGENTS.join(", ")}

The role file body IS the role text — plain prose, no format to get right.
Edit it and restart that agent; \`abg claude\` / \`abg codex\` re-render the
matching section of CLAUDE.md / AGENTS.md on every launch.
`);
}

function requireAgent(value: string | undefined): RoleAgent {
  if (value && (ROLE_AGENTS as readonly string[]).includes(value)) {
    return value as RoleAgent;
  }
  console.error(
    value
      ? `Unknown agent "${value}". Expected one of: ${ROLE_AGENTS.join(", ")}`
      : `Missing agent. Expected one of: ${ROLE_AGENTS.join(", ")}`,
  );
  process.exit(1);
}

function listRoles(projectRoot: string): void {
  console.log(`Agent roles for ${projectRoot}\n`);

  for (const agent of ROLE_AGENTS) {
    const path = roleFilePath(projectRoot, agent);
    const rel = relative(projectRoot, path);
    console.log(`${agent}`);
    console.log(`  file:     ${rel}`);

    if (!existsSync(path)) {
      console.log(`  source:   built-in default (no role file yet)`);
      console.log(`  fix:      abg roles edit ${agent}   # creates it from the default`);
      console.log("");
      continue;
    }

    let text: string;
    try {
      text = readRoleText(projectRoot, agent).text;
    } catch (err) {
      console.log(`  source:   UNUSABLE`);
      console.log(`  problem:  ${err instanceof RoleFileError ? err.message.split("\n")[0] : String(err)}`);
      console.log(`  fix:      write the role text, or \`abg roles reset ${agent}\``);
      console.log("");
      continue;
    }

    const customized = text.trim() !== seededRoleText(agent).trim();
    console.log(`  source:   ${customized ? "yours (customized)" : "built-in default, unmodified"}`);

    const [outcome] = syncRoleSections(projectRoot, { dryRun: true, agents: [agent] });
    const renderedInto = relative(projectRoot, outcome.file);
    if (outcome.status === "skipped") {
      console.log(`  rendered: BLOCKED — ${outcome.detail}`);
    } else if (outcome.status === "unchanged") {
      console.log(`  rendered: live in ${renderedInto}`);
    } else {
      console.log(`  rendered: OUT OF DATE in ${renderedInto} — restart with \`abg ${agent}\``);
    }

    const missing = missingRoutingMarkers(text, agent);
    if (missing.length > 0) {
      console.log(`  warning:  no mention of ${missing.join(" ")} — ${agent} may stop tagging`);
      console.log(`            messages, which sends them all to the pull queue.`);
    }
    console.log("");
  }

  console.log("Edit a file and restart that agent. `abg roles --help` for more.");
}

async function editRole(projectRoot: string, agent: RoleAgent): Promise<void> {
  const path = roleFilePath(projectRoot, agent);
  if (!existsSync(path)) {
    seedRoleFiles(projectRoot, [agent]);
    console.log(`Created ${relative(projectRoot, path)} from the built-in default.`);
  }

  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    console.log("");
    console.log("No $EDITOR or $VISUAL set. Open it yourself:");
    console.log(`  ${path}`);
    console.log("");
    console.log(`Then run \`abg roles apply\` (or just restart with \`abg ${agent}\`).`);
    return;
  }

  // `shell: true` is required because $EDITOR is conventionally a
  // command line ("code --wait", "emacsclient -nw"), not a bare
  // binary. That means the path is pasted into a shell command rather
  // than passed as argv, so it has to be quoted: project roots with
  // spaces are ordinary, and unquoted the editor would open two files
  // it cannot find instead of the role.
  const result = spawnSync(`${editor} ${shellQuote(path)}`, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`Editor exited with status ${result.status ?? "unknown"} — leaving the file as-is.`);
    process.exit(1);
  }

  applyRoles(projectRoot, [agent]);
  console.log(`Restart ${agent} (\`abg ${agent}\`) for the change to take effect.`);
}

function applyRoles(projectRoot: string, agents: readonly RoleAgent[] = ROLE_AGENTS): void {
  for (const agent of agents) {
    let outcomes;
    try {
      outcomes = syncRoleSections(projectRoot, { agents: [agent] });
    } catch (err) {
      console.error(err instanceof RoleFileError ? err.message : String(err));
      process.exitCode = 1;
      continue;
    }
    for (const outcome of outcomes) {
      const rel = relative(projectRoot, outcome.file);
      if (outcome.status === "skipped") {
        console.error(`${rel}: not rendered — ${outcome.detail}`);
        process.exitCode = 1;
      } else if (outcome.status === "unchanged") {
        console.log(`${rel}: already up to date`);
      } else {
        const source = outcome.usedDefault
          ? "the built-in default (no role file yet)"
          : relative(projectRoot, roleFilePath(projectRoot, agent));
        console.log(`${rel}: ${outcome.status} from ${source}`);
      }
    }
    warnOnMissingRoutingMarkers(projectRoot, agent);
  }
}

async function resetRole(projectRoot: string, agent: RoleAgent, force: boolean): Promise<void> {
  const path = roleFilePath(projectRoot, agent);
  const rel = relative(projectRoot, path);
  const hasCustomText =
    existsSync(path) && readFileSync(path, "utf-8").trim() !== seededRoleText(agent).trim();

  if (hasCustomText && !force) {
    if (!process.stdin.isTTY) {
      console.error(`${rel} contains your own text. Refusing to overwrite it without --force.`);
      process.exit(1);
    }
    const ok = await confirm(`Overwrite ${rel} with the built-in default? Your text is lost. [y/N] `);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  writeDefaultRoleFile(projectRoot, agent);
  console.log(`${rel}: restored to the built-in default.`);
  applyRoles(projectRoot, [agent]);
  console.log(`Restart ${agent} (\`abg ${agent}\`) for the change to take effect.`);
}

/**
 * POSIX single-quote escaping. Everything inside '…' is literal except
 * a single quote itself, which is closed, escaped, and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
