/**
 * Per-agent role files: the editable source of truth for what each
 * agent is told it is.
 *
 * The collaboration text used to be compiled into the binary and
 * stamped into CLAUDE.md / AGENTS.md by `abg init`. That made the
 * rendered block the only copy, and it sat between regenerated
 * markers — so the one place a user would naturally edit was also the
 * one place that got overwritten on the next init. The role was
 * effectively a constant.
 *
 * Now setup seeds `.agentbridge/roles/<agent>.md` with the built-in
 * default text and never touches it again. That file is the source;
 * the marked block in CLAUDE.md / AGENTS.md is rendered output,
 * refreshed on every launch. Edit the role file, restart the agent.
 *
 * There is deliberately no format: the file body IS the role text.
 * No frontmatter, no headings the parser cares about, no preset
 * indirection — so there is no such thing as a malformed role file
 * and no parse errors to report. The single exception is an empty
 * file, which is treated as an unfinished edit rather than a silent
 * fallback to the default (see `readRoleText`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertMarkedSection } from "./marker-section";
import {
  MARKER_ID,
  CLAUDE_MD_SECTION,
  AGENTS_MD_SECTION,
} from "./collaboration-content";

/** Agents that get a role file. Adding one here is the whole change. */
export const ROLE_AGENTS = ["claude", "codex"] as const;
export type RoleAgent = (typeof ROLE_AGENTS)[number];

/**
 * Where each agent's rendered role lands. These filenames are fixed by
 * the agents themselves — Claude Code reads CLAUDE.md, Codex reads
 * AGENTS.md — so they are not configurable.
 */
const INSTRUCTION_FILE: Record<RoleAgent, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
};

/** Built-in text used to seed a role file, and to fall back to if one is deleted. */
const DEFAULT_ROLE_TEXT: Record<RoleAgent, string> = {
  claude: CLAUDE_MD_SECTION,
  codex: AGENTS_MD_SECTION,
};

/**
 * Prepended to a seeded role file. Rendered into the instruction file
 * along with everything else, on purpose: someone reading CLAUDE.md
 * needs to know that editing the block they are looking at accomplishes
 * nothing, and where the real source lives.
 */
function banner(agent: RoleAgent): string {
  return `<!-- Source: .agentbridge/roles/${agent}.md — edit that file, not this block.
     \`abg ${agent}\` re-renders this section from it on every launch. -->`;
}

/**
 * Exactly what a freshly seeded role file contains: the banner plus
 * the built-in default. Compare against this — not against the default
 * alone — to tell "still stock" from "the user changed it".
 */
export function seededRoleText(agent: RoleAgent): string {
  return `${banner(agent)}\n\n${DEFAULT_ROLE_TEXT[agent]}\n`;
}

export function rolesDir(projectRoot: string): string {
  return join(projectRoot, ".agentbridge", "roles");
}

export function roleFilePath(projectRoot: string, agent: RoleAgent): string {
  return join(rolesDir(projectRoot), `${agent}.md`);
}

export function instructionFilePath(projectRoot: string, agent: RoleAgent): string {
  return join(projectRoot, INSTRUCTION_FILE[agent]);
}

/**
 * Thrown for a role file the user has to fix. Carries the path so
 * every caller can point at it without rebuilding the message.
 */
export class RoleFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "RoleFileError";
  }
}

export interface SeedOutcome {
  agent: RoleAgent;
  path: string;
  /** False when the file already existed and was left alone. */
  created: boolean;
}

/**
 * Write the default role text for any agent that does not have a role
 * file yet. Existing files are never overwritten — that is the whole
 * contract, and it is what makes re-running setup safe after the user
 * has customized their roles.
 *
 * Pass `agents` to seed a subset (`abg roles edit codex` should not
 * quietly materialize a claude.md the user never asked for).
 */
export function seedRoleFiles(
  projectRoot: string,
  agents: readonly RoleAgent[] = ROLE_AGENTS,
): SeedOutcome[] {
  mkdirSync(rolesDir(projectRoot), { recursive: true });

  return agents.map((agent) => {
    const path = roleFilePath(projectRoot, agent);
    if (existsSync(path)) return { agent, path, created: false };
    writeFileSync(path, seededRoleText(agent), "utf-8");
    return { agent, path, created: true };
  });
}

/**
 * Overwrite an agent's role file with the built-in default.
 *
 * The deliberate opposite of `seedRoleFiles`, which never overwrites.
 * Callers are responsible for confirming with the user first — this
 * discards whatever they had written.
 */
export function writeDefaultRoleFile(projectRoot: string, agent: RoleAgent): string {
  mkdirSync(rolesDir(projectRoot), { recursive: true });
  const path = roleFilePath(projectRoot, agent);
  writeFileSync(path, seededRoleText(agent), "utf-8");
  return path;
}

export interface RoleText {
  text: string;
  /** True when no role file existed and the built-in default was used. */
  fromDefault: boolean;
}

/**
 * Read an agent's role text.
 *
 * A missing file falls back to the built-in default: the user may have
 * an older project, or deleted the file to get the default back, and
 * neither should break a launch.
 *
 * A file that exists but is blank does NOT fall back. Blank means a
 * half-finished edit, and quietly substituting the default would leave
 * the user believing their role text is live when the agent is running
 * on stock instructions — the failure mode worth being loud about.
 */
export function readRoleText(projectRoot: string, agent: RoleAgent): RoleText {
  const path = roleFilePath(projectRoot, agent);
  if (!existsSync(path)) {
    return { text: DEFAULT_ROLE_TEXT[agent], fromDefault: true };
  }

  const raw = readFileSync(path, "utf-8");
  if (raw.trim() === "") {
    throw new RoleFileError(
      `Role file is empty: ${path}\n` +
        `An empty role file is treated as an unfinished edit, not a request for the default.\n` +
        `Write the role text you want, or delete the file to fall back to the built-in default.`,
      path,
    );
  }
  return { text: raw.trim(), fromDefault: false };
}

/**
 * Markers the bridge routes on. A role file is free prose and may say
 * anything, but if it stops explaining these the agent stops tagging
 * its messages and everything silently falls into the pull queue.
 */
const ROUTING_MARKERS = ["[REPLY]", "[STATUS]", "[FYI]"] as const;

/**
 * Routing markers this agent's built-in default explains but `text`
 * does not — i.e. what the user's rewrite dropped.
 *
 * Calibrated against the default rather than the full marker list on
 * purpose: the two agents are told about different subsets, and
 * flagging a marker the stock role never mentioned would fire on an
 * untouched project and teach the user to ignore the warning.
 *
 * A warning, never an error. Rewriting a role from scratch is the
 * point of the feature, and someone who drops `[FYI]` deliberately
 * should not be blocked. This only makes dropping it *by accident*
 * visible now instead of debugged later as "Codex went quiet".
 */
export function missingRoutingMarkers(text: string, agent: RoleAgent): string[] {
  const baseline = DEFAULT_ROLE_TEXT[agent];
  return ROUTING_MARKERS.filter((m) => baseline.includes(m) && !text.includes(m));
}

export interface SyncOutcome {
  agent: RoleAgent;
  /** The instruction file that was (or would have been) written. */
  file: string;
  status: "unchanged" | "created" | "updated" | "appended" | "skipped";
  /** Populated for "skipped" — why the write did not happen. */
  detail?: string;
  usedDefault: boolean;
}

/**
 * Render every agent's role file into its instruction file, between
 * the AgentBridge markers.
 *
 * Idempotent: when the rendered block already matches, nothing is
 * written and the outcome is "unchanged". That is what makes it safe
 * to call on every launch.
 *
 * Pass `dryRun` to compute the outcomes without touching disk — used
 * by `abg doctor` to report drift without repairing it.
 *
 * Pass `agents` to render a subset. `abg claude` renders only
 * CLAUDE.md: a broken codex role file is not a reason to block a
 * Claude launch, and vice versa.
 */
export function syncRoleSections(
  projectRoot: string,
  opts: { dryRun?: boolean; agents?: readonly RoleAgent[] } = {},
): SyncOutcome[] {
  return (opts.agents ?? ROLE_AGENTS).map((agent) => {
    const file = instructionFilePath(projectRoot, agent);
    const { text, fromDefault } = readRoleText(projectRoot, agent);

    let existing = "";
    try {
      existing = readFileSync(file, "utf-8");
    } catch (err) {
      // A missing instruction file is the normal case on a fresh
      // project — upsert creates it from scratch. Any *other* read
      // failure is not a green light to write: treating an unreadable
      // but present CLAUDE.md as empty would replace the user's whole
      // file with nothing but our block.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return {
          agent,
          file,
          status: "skipped",
          detail: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
          usedDefault: fromDefault,
        };
      }
    }

    let updated: string;
    try {
      updated = upsertMarkedSection(existing, MARKER_ID, text);
    } catch (err) {
      // Malformed markers (a stray start without its end). Refuse
      // rather than append a second block; marker-section explains why.
      return {
        agent,
        file,
        status: "skipped",
        detail: err instanceof Error ? err.message : String(err),
        usedDefault: fromDefault,
      };
    }

    if (updated === existing) {
      return { agent, file, status: "unchanged", usedDefault: fromDefault };
    }

    const status: SyncOutcome["status"] =
      existing === ""
        ? "created"
        : existing.includes(`<!-- ${MARKER_ID}:start -->`)
          ? "updated"
          : "appended";

    if (!opts.dryRun) writeFileSync(file, updated, "utf-8");
    return { agent, file, status, usedDefault: fromDefault };
  });
}
