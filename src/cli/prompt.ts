/**
 * Arrow-key picker for CLI prompts.
 *
 * Renders a title, an optional example block (any pre-formatted text),
 * and a list of selectable options. User navigates with arrow keys (or
 * j/k / digits) and confirms with Enter. Esc / Ctrl-C cancels.
 *
 * Falls back gracefully when stdin or stdout is not a TTY: the picker
 * returns the default option's value without any I/O. This keeps the
 * caller safe in non-interactive contexts (CI, pipes, headless scripts).
 *
 * All ANSI emitted is plain VT100 - no curses dependency - so it works
 * over ssh and inside tmux/screen.
 */

export interface PickerOption<V = string> {
  /** Value returned on selection. */
  value: V;
  /** Short label shown on the option line. */
  label: string;
  /** Optional description shown to the right of the label, dimmed. */
  description?: string;
}

export interface PickerInput<V = string> {
  /**
   * Optional raw prelude rendered above the top rule (no indent, no
   * bold). Useful for a logo banner you want erased together with
   * the rest of the prompt on exit. Counted in the ephemeral
   * erase region so Esc / Enter wipes it too.
   */
  prelude?: string;
  /** Headline question. */
  title: string;
  /** Optional pre-formatted example block, rendered between title and options. */
  example?: string;
  /** Options to choose from. Must be non-empty. */
  options: PickerOption<V>[];
  /** Initial cursor position. Clamped to range. */
  defaultIndex?: number;
  /** Disable ANSI colors. Auto-detects from NO_COLOR / TTY when unset. */
  noColor?: boolean;
  /** Override stdin (for tests). */
  stdin?: NodeJS.ReadStream;
  /** Override stdout (for tests). */
  stdout?: NodeJS.WriteStream;
  /** Force interactive mode regardless of TTY detection (for tests). */
  forceInteractive?: boolean;
}

interface Colors {
  reset: string;
  bold: string;
  dim: string;
  italic: string;
  /** Accent color for the selected option (matches Claude Code's prompt style). */
  selected: string;
}

function makeColors(enabled: boolean): Colors {
  if (!enabled) {
    return { reset: "", bold: "", dim: "", italic: "", selected: "" };
  }
  return {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    // Bright blue, matching the highlight Claude Code uses for the
    // current option in its own dev-channels confirmation prompt.
    selected: "\x1b[94m",
  };
}

function isInteractive(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, forced?: boolean): boolean {
  if (forced) return true;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/**
 * Run the picker. Resolves with the selected option's value, or null if
 * the user cancelled (Esc / Ctrl-C) or the environment is non-interactive
 * AND no default was supplied.
 *
 * In non-interactive environments with a defaultIndex (the common case)
 * we return the default value silently - callers should treat that as the
 * "no choice made" path if they need to distinguish.
 */
export async function arrowPicker<V>(input: PickerInput<V>): Promise<V | null> {
  if (input.options.length === 0) {
    throw new Error("arrowPicker requires at least one option");
  }

  const stdin = input.stdin ?? (process.stdin as NodeJS.ReadStream);
  const stdout = input.stdout ?? (process.stdout as NodeJS.WriteStream);
  const colorsOn = input.noColor === false
    ? false
    : input.noColor === true
      ? false
      : !process.env.NO_COLOR && Boolean(stdout.isTTY);
  const c = makeColors(colorsOn);

  const defaultIdx = clamp(input.defaultIndex ?? 0, 0, input.options.length - 1);

  if (!isInteractive(stdin, stdout, input.forceInteractive)) {
    return input.options[defaultIdx].value;
  }

  // Track total lines emitted so we can erase the whole prompt on
  // exit. The prompt is ephemeral: when the user picks (or cancels)
  // the rendered region is wiped, leaving the terminal as it was
  // before. The next prompt then renders in the same spot.
  const ruleWidth = Math.min(80, Math.max(40, (stdout as any).columns ?? 64));
  let linesEmitted = 0;
  const writeLine = (s: string): void => {
    stdout.write(s);
    linesEmitted++;
  };

  // Optional prelude (e.g. a logo banner). Each line is emitted raw
  // and counted, so it gets wiped together with the rest of the
  // prompt on Esc / Enter.
  if (input.prelude) {
    for (const line of input.prelude.split("\n")) {
      writeLine(line + "\n");
    }
    writeLine("\n");
  }

  // Header: top rule + title.
  writeLine(`${c.dim}${"─".repeat(ruleWidth)}${c.reset}\n`);
  writeLine("\n");
  writeLine(`  ${c.bold}${input.title}${c.reset}\n`);

  // Example block.
  if (input.example) {
    writeLine("\n");
    for (const line of input.example.split("\n")) {
      writeLine(`  ${line}\n`);
    }
  }

  writeLine("\n");

  let idx = defaultIdx;
  // Count of "live" lines that re-render on each navigation
  // (option lines + blank + footer line).
  const liveLines = input.options.length + 2;

  const render = (first: boolean): void => {
    if (!first) {
      // Move cursor up over the live region to overwrite in place.
      stdout.write(`\x1b[${liveLines}A`);
    }
    for (let i = 0; i < input.options.length; i++) {
      const opt = input.options[i];
      const isSel = i === idx;
      const marker = isSel ? `${c.selected}❯${c.reset}` : " ";
      const num = `${i + 1}.`;
      const labelColor = isSel ? c.selected : "";
      let line = `  ${marker} ${labelColor}${num} ${opt.label}${c.reset}`;
      if (opt.description) {
        line += `  ${c.dim}${opt.description}${c.reset}`;
      }
      if (first) writeLine(`\r${line}\x1b[K\n`);
      else stdout.write(`\r${line}\x1b[K\n`);
    }
    if (first) {
      writeLine(`\x1b[K\n`);
      writeLine(`  ${c.italic}${c.dim}Enter to confirm · Esc to cancel${c.reset}\x1b[K\n`);
    } else {
      stdout.write(`\x1b[K\n`);
      stdout.write(`  ${c.italic}${c.dim}Enter to confirm · Esc to cancel${c.reset}\x1b[K\n`);
    }
  };

  // Erase every line we have written so the next prompt (or the
  // shell) starts from a clean position. Called on every exit path.
  const eraseAll = (): void => {
    if (linesEmitted <= 0) return;
    // Move cursor to the start of the first emitted line then clear
    // everything from there down.
    stdout.write(`\r\x1b[${linesEmitted}A\x1b[J`);
    linesEmitted = 0;
  };

  render(true);

  return new Promise<V | null>((resolve) => {
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      // No raw-mode support - fall back to default selection.
      resolve(input.options[defaultIdx].value);
      return;
    }
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer): void => {
      // A single keystroke may arrive as one or more bytes; an escape
      // sequence can also be split across chunks. We parse the buffer
      // greedily byte-by-byte and stop at the first decisive action.
      const s = chunk.toString("utf8");
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        // Ctrl-C
        if (ch === "\x03") {
          cleanup();
          eraseAll();
          resolve(null);
          return;
        }

        // Enter
        if (ch === "\r" || ch === "\n") {
          cleanup();
          eraseAll();
          resolve(input.options[idx].value);
          return;
        }

        // Esc - may be standalone or start of arrow sequence
        if (ch === "\x1b") {
          const next = s[i + 1];
          const after = s[i + 2];
          if (next === "[" && (after === "A" || after === "B")) {
            if (after === "A") idx = (idx - 1 + input.options.length) % input.options.length;
            else idx = (idx + 1) % input.options.length;
            i += 2;
            render(false);
            continue;
          }
          // Standalone Esc - cancel
          cleanup();
          eraseAll();
          resolve(null);
          return;
        }

        // Vim-style nav
        if (ch === "j" || ch === "J") {
          idx = (idx + 1) % input.options.length;
          render(false);
          continue;
        }
        if (ch === "k" || ch === "K") {
          idx = (idx - 1 + input.options.length) % input.options.length;
          render(false);
          continue;
        }

        // Digit shortcut: 1-9 selects and confirms immediately
        if (ch >= "1" && ch <= "9") {
          const n = ch.charCodeAt(0) - "1".charCodeAt(0);
          if (n < input.options.length) {
            idx = n;
            cleanup();
            eraseAll();
            resolve(input.options[idx].value);
            return;
          }
        }
        // Any other byte: ignore (do not re-render).
      }
    };

    stdin.on("data", onData);
  });
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
