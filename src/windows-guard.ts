/**
 * Native-Windows fail-fast guard.
 *
 * AgentBridge's process-management layer is POSIX-native, not
 * POSIX-flavoured: `ps -p <pid> -o command=` is how it proves a live
 * pid is its own daemon, and a cross-process SIGTERM is how it asks
 * that daemon to shut down cleanly. Neither has a Windows equivalent
 * that a flag change would reach — on Windows `process.kill(pid, sig)`
 * terminates the target outright rather than delivering a catchable
 * signal, so the daemon's own `shutdown()` never runs and its
 * `codex app-server` child is orphaned.
 *
 * Left unguarded, none of that surfaces as an error. The identity
 * check fails closed, so `abg kill` reports "Pid N is alive but is NOT
 * an AgentBridge daemon — refusing to kill", and a first launch spends
 * 30 seconds in `waitForReady` before timing out against a daemon that
 * is running fine and simply cannot be recognised. Both readings point
 * the user at their own machine instead of at the unsupported platform.
 *
 * WSL2 needs no detection: to a process inside it, `platform()` is
 * "linux", because it is. Everything in this codebase already works
 * there.
 *
 * The escape hatch exists for someone porting the process layer, who
 * needs to reach the code past this point to test it. It is not a
 * supported configuration and says so.
 */

import { platform } from "node:os";

export const ALLOW_NATIVE_WINDOWS_ENV = "AGENTBRIDGE_ALLOW_NATIVE_WINDOWS";

export type WindowsGuardVerdict =
  | { action: "proceed" }
  | { action: "warn"; message: string }
  | { action: "refuse"; message: string };

const REFUSAL = `AgentBridge does not support native Windows.

Run it under WSL2 instead — AgentBridge works there unmodified, and
WSL2 is also what OpenAI recommends for Codex CLI, so it is the better
environment for both halves of the bridge.

Setup, from PowerShell:

  1. wsl --install -d Ubuntu        # then reboot if prompted
  2. wsl                            # drop into the Ubuntu shell
  3. curl -fsSL https://bun.sh/install | bash
  4. npm install -g @anthropic-ai/claude-code @openai/codex
  5. cd /mnt/c/path/to/your/project
  6. npm install -g @rowanng/agentbridge
  7. abg init

Keep the project on the Linux filesystem (~/code/...) rather than under
/mnt/c if you can — cross-filesystem file watching is slow enough to be
noticeable.

Details: https://github.com/ngna3007/agent-bridge/blob/master/docs/windows.md`;

const OVERRIDE_WARNING = `[abg] ${ALLOW_NATIVE_WINDOWS_ENV}=1 — running on native Windows anyway.
[abg] Unsupported. Daemon identity checks and graceful shutdown do not
[abg] work here; expect refused kills, orphaned processes, and a 30s
[abg] readiness timeout on launch. See docs/windows.md.`;

/**
 * Commands that must not run on an unsupported platform.
 *
 * Help and version are the exception, and deliberately so: someone on
 * Windows finding out AgentBridge will not run here is exactly the
 * person who needs `--help` to work, and package managers probe
 * `--version` on an installed binary regardless of whether it can do
 * anything useful. Both answer from static strings and touch no
 * daemon, no ports, and no state directory.
 *
 * Every other command either spawns a process, talks to the daemon, or
 * writes state — the three things that break here.
 */
const PLATFORM_EXEMPT_COMMANDS = new Set(["--help", "-h", "--version", "-v"]);

export function commandNeedsSupportedPlatform(command: string | undefined): boolean {
  // A bare `abg` prints help.
  if (command === undefined) return false;
  return !PLATFORM_EXEMPT_COMMANDS.has(command);
}

/**
 * Decide what to do on this platform. Pure, so the decision is
 * testable from a Linux CI box — `assertSupportedPlatform` below is
 * the thin `process.exit` wrapper around it.
 */
export function checkPlatformSupport(
  osPlatform: string = platform(),
  env: Record<string, string | undefined> = process.env,
): WindowsGuardVerdict {
  if (osPlatform !== "win32") return { action: "proceed" };
  if (env[ALLOW_NATIVE_WINDOWS_ENV] === "1") {
    return { action: "warn", message: OVERRIDE_WARNING };
  }
  return { action: "refuse", message: REFUSAL };
}

/**
 * Refuse to go further when the platform cannot support what follows.
 *
 * Called from both process entry points — the CLI (`cli.ts`, gated on
 * `commandNeedsSupportedPlatform`) and the plugin-spawned MCP server
 * (`bridge.ts`, unconditionally, since it has no command to classify
 * and does nothing but attach to a daemon). Two enforcement points,
 * one policy: `checkPlatformSupport` above is the only place that
 * decides, so the two can never drift into disagreeing about what
 * "supported" means.
 *
 * In the CLI it runs before every other step, because resolving the
 * project namespace, offering first-run setup, and spawning a daemon
 * each either fail or half-succeed here — and a half-finished setup is
 * harder to explain than a refusal.
 */
export function assertSupportedPlatform(
  write: (s: string) => void = (s) => process.stderr.write(s),
  exit: (code: number) => never = process.exit as (code: number) => never,
): void {
  const verdict = checkPlatformSupport();
  if (verdict.action === "proceed") return;
  write(`${verdict.message}\n`);
  if (verdict.action === "refuse") exit(1);
}
