/**
 * Saving and restoring the terminal around a child TUI.
 *
 * The Codex TUI puts the terminal into raw mode, the alternate screen,
 * bracketed paste, focus tracking, and keyboard-enhancement mode. When
 * it exits cleanly it undoes all of that itself. When it is killed, or
 * panics, or the daemon tears the session down underneath it, it does
 * not — and the user is left with a shell that does not echo, has no
 * cursor, and paints garbage on every keystroke. Recovering from that
 * means knowing to type a blind `stty sane`, which nobody does.
 *
 * So the wrapper takes responsibility: capture `stty -g` before the
 * spawn, and on every exit path push the terminal back to a sane state.
 *
 * The syscalls are injected rather than imported because this is the
 * one path in the CLI that cannot be exercised from a test runner —
 * there is no TTY, `stty` would fail, and `/dev/tty` does not open. The
 * `TerminalIo` seam is what makes the ordering and the fallbacks
 * assertable; `nodeTerminalIo()` is the only production implementation.
 */

import { execFileSync, type StdioOptions } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

/**
 * Escape sequences written on the way out, in this order. Each one
 * undoes a mode the TUI may have set; they are all no-ops on a terminal
 * that was never in that mode, which is why it is safe to send the
 * whole list unconditionally.
 */
export const RESTORE_SEQUENCES = [
  "\x1b[<u", // Disable keyboard enhancement (kitty protocol)
  "\x1b[?2004l", // Disable bracketed paste
  "\x1b[?1004l", // Disable focus tracking
  "\x1b[?1049l", // Leave alternate screen
  "\x1b[?25h", // Show cursor
  "\x1b[0m", // Reset character attributes
] as const;

export interface TerminalIo {
  isStdinTty: boolean;
  isStdoutTty: boolean;
  /**
   * Run `stty` against the controlling terminal. Throws on failure.
   *
   * Takes an argv array, not a command string: the saved state is
   * pasted straight back in as an argument, and no shell should ever
   * get a look at it.
   */
  stty: (args: string[]) => void;
  /** Open /dev/tty for writing. Throws when there is no controlling terminal. */
  openTty: () => number;
  write: (fd: number, text: string) => void;
  close: (fd: number) => void;
}

/** Stdout of the child TUI is fd 1; writing there needs no close. */
const STDOUT_FD = 1;

export function nodeTerminalIo(): TerminalIo {
  return {
    isStdinTty: Boolean(process.stdin.isTTY),
    isStdoutTty: Boolean(process.stdout.isTTY),
    stty: (args) => {
      // stdin must be inherited: `stty` acts on the terminal attached to
      // its own stdin, so a piped or ignored fd would silently target
      // nothing. Output is discarded — a failure is signalled by the throw.
      execFileSync("stty", args, { stdio: ["inherit", "ignore", "ignore"] as StdioOptions });
    },
    openTty: () => openSync("/dev/tty", "w"),
    write: (fd, text) => {
      writeSync(fd, text);
    },
    close: (fd) => {
      closeSync(fd);
    },
  };
}

/**
 * Capture the current terminal settings, or null when there is nothing
 * to capture (no TTY) or `stty` is unavailable.
 *
 * A null result is not an error: `restoreTerminal` still sends the
 * escape sequences, which is the part that matters on a terminal
 * without a usable `stty`.
 */
export function saveTerminalState(io: TerminalIo = nodeTerminalIo()): string | null {
  if (!io.isStdinTty) return null;
  try {
    return sttyCapture(["-g"]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Put the terminal back the way it was.
 *
 * Two independent halves, deliberately not short-circuited on each
 * other: line discipline via `stty`, then the escape sequences. Either
 * can fail on its own — a container with no `/dev/tty` still wants the
 * `stty` restore, and a terminal where `stty` is missing still wants the
 * cursor turned back on.
 *
 * Never throws. It runs on the exit path, where an exception would
 * replace the child's real exit reason with a stack trace about a
 * terminal.
 */
export function restoreTerminal(saved: string | null, io: TerminalIo = nodeTerminalIo()): void {
  if (saved && io.isStdinTty) {
    try {
      io.stty([saved]);
    } catch {
      // The saved string came from this terminal, so a failure here
      // means the terminal changed under us (resize, reattach, a
      // different tty). `stty sane` is not the old state but it is a
      // usable one, which is the actual goal.
      try {
        io.stty(["sane"]);
      } catch {
        /* no stty at all — the escape sequences below are the fallback */
      }
    }
  }

  let ttyFd: number | null = null;
  try {
    ttyFd = io.openTty();
  } catch {
    // No controlling terminal to write to. stdout is the next best
    // thing when it is itself a terminal; when it is a pipe, sending
    // escape codes would only corrupt whatever is reading it.
    ttyFd = io.isStdoutTty ? STDOUT_FD : null;
  }
  if (ttyFd === null) return;

  for (const seq of RESTORE_SEQUENCES) {
    try {
      io.write(ttyFd, seq);
    } catch {
      /* keep going: a later sequence may still land, and the cursor
         is the last one in the list */
    }
  }

  // Only close what we opened. Closing fd 1 would take stdout with it.
  if (ttyFd !== STDOUT_FD) {
    try {
      io.close(ttyFd);
    } catch {}
  }
}

/**
 * `stty -g` is the one invocation whose *output* is needed, so it
 * cannot go through `TerminalIo.stty`. Only ever called from
 * `saveTerminalState`, which is skipped entirely without a TTY.
 */
function sttyCapture(args: string[]): string {
  return execFileSync("stty", args, { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
}
