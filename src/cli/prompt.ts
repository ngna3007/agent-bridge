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
  green: string;
  cyan: string;
  yellow: string;
}

function makeColors(enabled: boolean): Colors {
  if (!enabled) {
    return { reset: "", bold: "", dim: "", green: "", cyan: "", yellow: "" };
  }
  return {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
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

  // Header (title + hint)
  stdout.write(`${c.bold}? ${input.title}${c.reset}  ${c.dim}(↑/↓ Enter · Esc cancels)${c.reset}\n`);

  // Example block (rendered once - never overwritten by re-renders)
  if (input.example) {
    stdout.write("\n");
    for (const line of input.example.split("\n")) {
      stdout.write(`  ${c.dim}│${c.reset} ${line}\n`);
    }
    stdout.write("\n");
  }

  let idx = defaultIdx;

  const render = (first: boolean): void => {
    if (!first) {
      // Move cursor up to overwrite the previous option block.
      stdout.write(`\x1b[${input.options.length}A`);
    }
    for (let i = 0; i < input.options.length; i++) {
      const opt = input.options[i];
      const selected = i === idx;
      const marker = selected ? `${c.green}▸${c.reset}` : " ";
      const labelStyle = selected ? c.bold : c.dim;
      let line = `  ${marker} ${labelStyle}${opt.label}${c.reset}`;
      if (opt.description) line += `  ${c.dim}- ${opt.description}${c.reset}`;
      // \r + \x1b[K = carriage-return + clear-to-end-of-line, so a longer
      // previous render does not leave artifacts behind a shorter new one.
      stdout.write(`\r${line}\x1b[K\n`);
    }
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
          stdout.write("\n");
          resolve(null);
          return;
        }

        // Enter
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
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
          stdout.write("\n");
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
            render(false);
            stdout.write("\n");
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
