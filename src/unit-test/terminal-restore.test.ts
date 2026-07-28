import { describe, expect, test } from "bun:test";
import {
  RESTORE_SEQUENCES,
  restoreTerminal,
  saveTerminalState,
  type TerminalIo,
} from "../cli/terminal-restore";

/**
 * A recording TerminalIo. Every branch of restoreTerminal is reachable
 * by choosing which of these throw — which is the entire reason the
 * syscalls are injected: on a test runner there is no TTY, `stty`
 * fails, and `/dev/tty` does not open, so none of this is observable
 * against the real thing.
 */
function fakeIo(overrides: Partial<TerminalIo> & { ttyFd?: number } = {}) {
  const calls: string[] = [];
  const written: Array<{ fd: number; text: string }> = [];
  const io: TerminalIo = {
    isStdinTty: true,
    isStdoutTty: true,
    stty: (args) => {
      calls.push(`stty ${args.join(" ")}`);
    },
    openTty: () => overrides.ttyFd ?? 7,
    write: (fd, text) => {
      written.push({ fd, text });
    },
    close: (fd) => {
      calls.push(`close ${fd}`);
    },
    ...overrides,
  };
  return { io, calls, written };
}

const NO_TTY = () => {
  throw new Error("ENXIO: no controlling terminal");
};

describe("saveTerminalState", () => {
  test("returns null without a TTY, and never shells out", () => {
    let ran = false;
    const { io } = fakeIo({
      isStdinTty: false,
      stty: () => {
        ran = true;
      },
    });

    expect(saveTerminalState(io)).toBeNull();
    expect(ran).toBe(false);
  });
});

describe("restoreTerminal", () => {
  test("restores the saved line discipline verbatim", () => {
    const { io, calls } = fakeIo();

    restoreTerminal("4500:5:bf:8a3b:3", io);

    expect(calls[0]).toBe("stty 4500:5:bf:8a3b:3");
  });

  test("passes the saved state as one argument, never as a shell string", () => {
    // `stty -g` output is machine-generated, but it reaches the shell
    // as an argument on every exit — so it goes through argv, not a
    // command string. Asserting the arity is what keeps it that way.
    const seen: string[][] = [];
    const { io } = fakeIo({ stty: (args) => seen.push(args) });

    restoreTerminal("a:b:c; rm -rf /", io);

    expect(seen).toEqual([["a:b:c; rm -rf /"]]);
  });

  test("falls back to `stty sane` when the saved state is rejected", () => {
    const calls: string[] = [];
    const { io } = fakeIo({
      stty: (args) => {
        calls.push(args.join(" "));
        if (args[0] !== "sane") throw new Error("stty: invalid argument");
      },
    });

    restoreTerminal("stale-state", io);

    expect(calls).toEqual(["stale-state", "sane"]);
  });

  test("still emits the escape sequences when stty is missing entirely", () => {
    const { io, written } = fakeIo({
      stty: () => {
        throw new Error("ENOENT: stty not found");
      },
    });

    restoreTerminal("anything", io);

    expect(written.map((w) => w.text)).toEqual([...RESTORE_SEQUENCES]);
  });

  test("skips stty when there was nothing saved, but still resets the screen", () => {
    let sttyCalls = 0;
    const { io, written } = fakeIo({ stty: () => void sttyCalls++ });

    restoreTerminal(null, io);

    expect(sttyCalls).toBe(0);
    expect(written).toHaveLength(RESTORE_SEQUENCES.length);
  });

  test("skips stty when stdin is not a TTY", () => {
    let sttyCalls = 0;
    const { io } = fakeIo({ isStdinTty: false, stty: () => void sttyCalls++ });

    restoreTerminal("saved", io);

    expect(sttyCalls).toBe(0);
  });

  test("writes every sequence to /dev/tty, in order, then closes it", () => {
    const { io, calls, written } = fakeIo({ ttyFd: 9 });

    restoreTerminal(null, io);

    expect(written.map((w) => w.text)).toEqual([...RESTORE_SEQUENCES]);
    expect(written.every((w) => w.fd === 9)).toBe(true);
    expect(calls).toContain("close 9");
  });

  test("cursor-show is emitted even if an earlier sequence fails", () => {
    // A partial write must not abandon the rest: "\x1b[?25h" is last in
    // the list and is the one the user actually notices.
    const written: string[] = [];
    const { io } = fakeIo({
      write: (_fd, text) => {
        if (text === "\x1b[?1049l") throw new Error("EPIPE");
        written.push(text);
      },
    });

    restoreTerminal(null, io);

    expect(written).toContain("\x1b[?25h");
    expect(written).not.toContain("\x1b[?1049l");
  });

  test("falls back to stdout when /dev/tty cannot be opened", () => {
    const { io, calls, written } = fakeIo({ openTty: NO_TTY });

    restoreTerminal(null, io);

    expect(written.every((w) => w.fd === 1)).toBe(true);
    // Closing fd 1 would take stdout down with it.
    expect(calls.some((c) => c.startsWith("close"))).toBe(false);
  });

  test("writes nothing when there is no tty and stdout is a pipe", () => {
    // Escape codes down a pipe corrupt whatever is reading it.
    const { io, written } = fakeIo({ openTty: NO_TTY, isStdoutTty: false });

    restoreTerminal("saved", io);

    expect(written).toHaveLength(0);
  });

  test("never throws, whatever fails", () => {
    const { io } = fakeIo({
      stty: () => {
        throw new Error("boom");
      },
      openTty: NO_TTY,
      isStdoutTty: false,
    });

    expect(() => restoreTerminal("saved", io)).not.toThrow();
  });
});
