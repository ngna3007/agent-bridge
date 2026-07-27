/**
 * Launch-time role rendering.
 *
 * `.agentbridge/roles/<agent>.md` is the source; the marked block in
 * CLAUDE.md / AGENTS.md is rendered output. Re-rendering on every
 * launch is what makes "edit the role file, restart the agent" the
 * whole workflow — there is no separate apply command to forget.
 *
 * Quiet when nothing changed, which is the normal case: a launch that
 * prints nothing here means the rendered block already matched.
 */

import { relative } from "node:path";
import { findProjectRoot } from "../project-id";
import {
  RoleFileError,
  missingRoutingMarkers,
  readRoleText,
  syncRoleSections,
  type RoleAgent,
} from "../roles";

/**
 * Render `agent`'s role file into its instruction file before the
 * agent starts.
 *
 * No-ops outside a project: without a `.agentbridge/` marker there is
 * no role file to render from and no project-local CLAUDE.md we own.
 *
 * Exits non-zero on an unusable role file. The alternative — launch
 * anyway on the built-in default — would hand the user an agent that
 * silently ignores the role they just wrote.
 */
export function syncRolesForLaunch(agent: RoleAgent, cwd = process.cwd()): void {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return;

  let outcomes;
  try {
    outcomes = syncRoleSections(projectRoot, { agents: [agent] });
  } catch (err) {
    if (err instanceof RoleFileError) {
      console.error(`[agentbridge] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  for (const outcome of outcomes) {
    const shown = relative(projectRoot, outcome.file) || outcome.file;
    if (outcome.status === "skipped") {
      console.error(`[agentbridge] ${shown}: role section not rendered — ${outcome.detail}`);
      continue;
    }
    if (outcome.status === "unchanged") continue;
    console.error(`[agentbridge] ${shown}: role section ${outcome.status} from .agentbridge/roles/${agent}.md`);
  }

  warnOnMissingRoutingMarkers(projectRoot, agent);
}

/**
 * A rewritten role is allowed to say anything, including nothing about
 * the marker protocol. Warn anyway: an agent that stops tagging its
 * messages looks like a broken bridge, not like a role edit, and the
 * two are hours apart in a user's memory by the time it shows up.
 */
function warnOnMissingRoutingMarkers(projectRoot: string, agent: RoleAgent): void {
  let text: string;
  try {
    const role = readRoleText(projectRoot, agent);
    if (role.fromDefault) return;
    text = role.text;
  } catch {
    return; // already reported by the caller
  }

  const missing = missingRoutingMarkers(text, agent);
  if (missing.length === 0) return;

  console.error(
    `[agentbridge] .agentbridge/roles/${agent}.md never mentions ${missing.join(" ")} — ` +
      `${agent} may stop tagging messages, sending them all to the pull queue.`,
  );
}
