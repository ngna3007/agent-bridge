/**
 * First-run project setup offer.
 *
 * Without a `.agentbridge/` marker, `abg claude` silently falls back to
 * single-instance mode: fixed ports 4500/4501/4502, a shared state dir,
 * and no collaboration section in CLAUDE.md / AGENTS.md. That fallback
 * works, which is exactly the problem — a user who never runs
 * `abg init` gets a degraded bridge and no indication that a better
 * mode exists. Two projects launched that way silently fight over one
 * daemon slot.
 *
 * So we ask. On the first `abg claude` / `abg codex` in an unmarked
 * directory, offer to set the project up. Yes runs the same code path
 * as `abg init`; no is remembered per directory so the question is
 * asked exactly once.
 *
 * Ordering matters: this must run BEFORE `maybeApplyProjectNamespace`
 * in cli.ts. The namespace is resolved once at startup, so a project
 * created after that point would not take effect until the next
 * launch — the user would answer "yes" and still get fallback ports.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { checkSetupLocation, findProjectRoot } from "../project-id";
import { StateDirResolver } from "../state-dir";
import { UserPrefsService } from "../user-prefs";
import { arrowPicker } from "./prompt";

// `./init` is imported lazily inside maybeOfferSetup. It pulls in
// ../cli for the marketplace constants, and cli.ts imports this
// module — a static import here would close that cycle and execute
// the CLI entry point on any import of the decision logic (including
// from tests).

/** Commands whose behavior depends on the project namespace. */
const SETUP_AWARE_COMMANDS = new Set(["claude", "codex"]);

export type SetupOfferDecision =
  | { offer: false; reason: SetupSkipReason }
  | { offer: true; targetDir: string; cwdIsTarget: boolean };

export type SetupSkipReason =
  | "not-setup-aware-command"
  | "already-a-project"
  | "opted-out-by-env"
  | "non-interactive"
  | "unsafe-location"
  | "previously-declined";

export interface SetupOfferContext {
  command: string | undefined;
  cwd: string;
  isInteractive: boolean;
  /** True when the user already answered "no" for this directory. */
  hasDeclined: (dir: string) => boolean;
  /** Reads AGENTBRIDGE_AUTO_SETUP; "0" / "false" disables the offer. */
  autoSetupEnv?: string;
  /** Injectable for tests. Defaults to a real `.git` lookup. */
  findGitRoot?: (from: string) => string | null;
  /** Injectable for tests. Defaults to the real home directory. */
  home?: string;
}

/**
 * Decide whether to offer setup, and for which directory. Pure apart
 * from the injected lookups, so every branch is testable without a
 * terminal or a filesystem.
 *
 * The target is the git root when the cwd sits inside a repo. Running
 * `abg claude` from `src/` should not create a project rooted at
 * `src/` — the marker would namespace a subdirectory and the sibling
 * `tests/` would resolve to a different project entirely.
 */
export function decideSetupOffer(ctx: SetupOfferContext): SetupOfferDecision {
  if (!ctx.command || !SETUP_AWARE_COMMANDS.has(ctx.command)) {
    return { offer: false, reason: "not-setup-aware-command" };
  }
  if (findProjectRoot(ctx.cwd)) {
    return { offer: false, reason: "already-a-project" };
  }
  const optOut = ctx.autoSetupEnv?.toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "no") {
    return { offer: false, reason: "opted-out-by-env" };
  }
  // Never create files unattended. A piped or CI run keeps the
  // historical single-instance fallback.
  if (!ctx.isInteractive) {
    return { offer: false, reason: "non-interactive" };
  }

  const gitRoot = (ctx.findGitRoot ?? findGitRoot)(ctx.cwd);
  const targetDir = gitRoot ?? resolve(ctx.cwd);

  if (checkSetupLocation(targetDir, ctx.home ?? homedir())) {
    return { offer: false, reason: "unsafe-location" };
  }
  if (ctx.hasDeclined(targetDir)) {
    return { offer: false, reason: "previously-declined" };
  }
  return { offer: true, targetDir, cwdIsTarget: targetDir === resolve(ctx.cwd) };
}

/** Walk upward from `from` to the first ancestor containing `.git`. */
export function findGitRoot(from: string): string | null {
  let cur = resolve(from);
  while (true) {
    if (existsSync(`${cur}/.git`)) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Run the first-run setup offer. Returns true when a project was
 * created, so the caller knows the namespace must now be resolved.
 *
 * Never throws: a failure here must not stop the user from launching
 * their agent, which is what they actually asked for.
 */
export async function maybeOfferSetup(command: string | undefined): Promise<boolean> {
  // The prefs file lives in the base state dir here, not a project
  // one — by definition no project exists yet at this point.
  const prefs = new UserPrefsService(new StateDirResolver());

  const decision = decideSetupOffer({
    command,
    cwd: process.cwd(),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    hasDeclined: (dir) => prefs.hasDeclinedSetup(dir),
    autoSetupEnv: process.env.AGENTBRIDGE_AUTO_SETUP,
  });

  if (!decision.offer) return false;

  const { targetDir, cwdIsTarget } = decision;
  const body = [
    "This directory is not set up as an AgentBridge project yet.",
    "",
    "Setting one up gives it a private daemon, its own port triple, and",
    "its own state — so several projects can run side by side. Without",
    "it, every unconfigured directory shares one bridge and the second",
    "one you launch takes the slot from the first.",
    "",
    "Setup writes:",
    `  ${targetDir}/.agentbridge/config.json`,
    `  a marked section in ${targetDir}/CLAUDE.md and AGENTS.md`,
    "",
    cwdIsTarget
      ? "Nothing outside those markers is modified."
      : `Note: using the git root, not the current directory.\nNothing outside those markers is modified.`,
  ].join("\n");

  const choice = await arrowPicker<"yes" | "no">({
    title: "Set up AgentBridge for this project?",
    example: body,
    options: [
      { value: "yes", label: "Yes, set it up", description: "same as `abg init`" },
      { value: "no", label: "No, use shared mode", description: "won't ask again here" },
    ],
    defaultIndex: 0,
  });

  // Esc cancels the launch outright rather than falling through to a
  // mode the user did not choose.
  if (choice === null) process.exit(0);

  if (choice === "no") {
    try {
      prefs.recordSetupDeclined(targetDir);
    } catch {
      // A prefs write failure costs one extra prompt next time.
      // Not worth blocking the launch over.
    }
    console.error("[abg] Continuing in shared single-instance mode. Run `abg init` any time to change that.");
    return false;
  }

  try {
    const { performProjectSetup, printCustomizationSummary } = await import("./init");
    performProjectSetup(targetDir);
    printCustomizationSummary(targetDir);
    console.log("");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[abg] Project setup failed: ${msg}`);
    console.error("[abg] Continuing in shared single-instance mode. Run `abg init` to retry.");
    return false;
  }
}
