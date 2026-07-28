/**
 * `abg log` — show what actually crossed the bridge.
 *
 * The daemon has always written a detailed log; there was simply no
 * command to read it. Debugging "Codex never got my message" meant
 * knowing that a per-project state dir exists, deriving the project id,
 * and running `tail -f` against a path nothing prints. That is a lot of
 * prerequisite knowledge for the single most common question users have.
 *
 * Two decisions shape this command:
 *
 * - **Filtered by default.** The raw log interleaves message flow with
 *   codex-server chatter, socket bookkeeping, and model-refresh noise.
 *   The default view keeps the lines that describe a message moving,
 *   an agent attaching, or something going wrong; `--all` opts back
 *   into everything, because the moment the filter hides the one line
 *   that mattered it has to be escapable.
 * - **Rotation-aware follow.** `--follow` tracks a byte offset, and a
 *   file that has *shrunk* means `RotatingLogger` renamed it out from
 *   under us. Reading from the stale offset would then emit garbage
 *   from the middle of a line, so a shrink resets to the start of the
 *   new file.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeNamespace } from "../runtime-namespace";

const DEFAULT_LINES = 40;
const FOLLOW_POLL_MS = 400;

/**
 * How much of the tail to read for the initial view. The log is capped
 * at 50 MB per generation, and slurping all of it to print 40 lines
 * would be absurd. Two megabytes is far more than enough history for
 * the filter to find a screenful, and bounds the read regardless of how
 * large the file has grown.
 */
const TAIL_READ_BYTES = 2_000_000;

/**
 * Lines the default view keeps.
 *
 * Deliberately matched against message text rather than a component
 * allowlist: the interesting events come from three different
 * components, and a component filter would either drop `CodexAdapter`
 * turn transitions or admit all of its subprocess output.
 */
const INTERESTING = new RegExp(
  [
    "Forwarding Claude",
    "Queued Claude",
    "Delivered queued reply",
    "Discarding \\d+ queued",
    "Dropping expired queued",
    "Injection rejected",
    "Injecting",
    "Pushing daemon",
    "Queueing daemon",
    "turn (started|completed)",
    "Claude frontend (attached|detached|contest)",
    "TUI (connected|disconnected)",
    "Codex ready",
    "Bridge fully operational",
    "lifecycle event",
    "shut(ting)? down",
    "exited",
    "\\bERROR\\b",
    "⚠️",
  ].join("|"),
  "i",
);

interface LogArgs {
  lines: number;
  follow: boolean;
  all: boolean;
  grep: RegExp | null;
}

/**
 * Parse flags, rejecting bad input rather than silently defaulting —
 * `abg log -n banana` quietly showing 40 lines is the kind of thing
 * that costs someone ten minutes.
 */
export function parseLogArgs(args: string[]): LogArgs {
  const parsed: LogArgs = { lines: DEFAULT_LINES, follow: false, all: false, grep: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "-f":
      case "--follow":
        parsed.follow = true;
        break;
      case "--all":
      case "-a":
        parsed.all = true;
        break;
      case "-n":
      case "--lines": {
        const raw = args[++i];
        const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--lines needs a positive integer, got ${raw ?? "nothing"}`);
        }
        parsed.lines = n;
        break;
      }
      case "--grep":
      case "-g": {
        const raw = args[++i];
        if (raw === undefined) throw new Error("--grep needs a pattern");
        try {
          parsed.grep = new RegExp(raw, "i");
        } catch (err) {
          throw new Error(`--grep pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      default:
        throw new Error(`Unknown option for \`abg log\`: ${arg}`);
    }
  }

  return parsed;
}

/** True when a line survives the active filters. */
export function keepLine(line: string, opts: Pick<LogArgs, "all" | "grep">): boolean {
  if (line.trim() === "") return false;
  if (opts.grep && !opts.grep.test(line)) return false;
  if (opts.all || opts.grep) return true;
  return INTERESTING.test(line);
}

/**
 * Rewrite the ISO timestamp as local wall-clock time.
 *
 * The stored form is unambiguous and correct for a file; it is the
 * wrong thing to *read*, because matching "was that before or after I
 * hit enter?" against a UTC millisecond string is pure friction. Lines
 * that do not match the expected shape pass through untouched — an
 * unparsed line is still worth seeing.
 */
export function formatLogLine(line: string, now = new Date()): string {
  const match = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[([^\]]+)\] ([\s\S]*)$/.exec(line);
  if (!match) return line;

  const when = new Date(match[1]!);
  if (Number.isNaN(when.getTime())) return line;

  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();

  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  const stamp = sameDay ? clock : `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${clock}`;

  return `${stamp}  ${shortComponent(match[2]!).padEnd(8)}  ${match[3]}`;
}

/**
 * Collapse the component names to something that fits beside the text.
 * They are long because they identify a class; in a log column they only
 * need to identify a side of the bridge.
 */
function shortComponent(component: string): string {
  switch (component) {
    case "AgentBridgeDaemon":
      return "daemon";
    case "AgentBridgeFrontend":
      return "bridge";
    case "CodexAdapter":
      return "codex";
    case "ClaudeAdapter":
      return "claude";
    default:
      return component.toLowerCase();
  }
}

export async function runLog(args: string[] = []) {
  let opts: LogArgs;
  try {
    opts = parseLogArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("Usage: abg log [-n <count>] [-f|--follow] [--all] [--grep <regex>]");
    process.exit(1);
    return;
  }

  const ns = resolveRuntimeNamespace({ mutateEnv: false });
  const logPath = join(ns.stateDir.dir, "agentbridge.log");

  if (!existsSync(logPath)) {
    console.log(`No log file yet at ${logPath}`);
    console.log("The daemon writes it on first launch — run `abg claude` or `abg codex`.");
    return;
  }

  const header = opts.all
    ? `${logPath} (everything)`
    : opts.grep
      ? `${logPath} (matching ${opts.grep.source})`
      : `${logPath} (message flow; --all for everything)`;
  console.log(header);
  console.log("");

  const content = readTail(logPath, TAIL_READ_BYTES);
  const kept = content.split("\n").filter((l) => keepLine(l, opts));
  for (const line of kept.slice(-opts.lines)) console.log(formatLogLine(line));

  if (!opts.follow) {
    if (kept.length === 0) {
      console.log(
        opts.all ? "(log is empty)" : "(nothing matched — try `abg log --all`)",
      );
    }
    return;
  }

  console.log("\n… following. Ctrl-C to stop.\n");
  await followLog(logPath, opts);
}

/**
 * Poll for appended bytes until interrupted.
 *
 * Polling rather than `fs.watch`: the log is appended to by up to four
 * writers across two processes, watch events coalesce under that, and
 * a 400ms poll on a local file costs nothing measurable. `partial`
 * holds a trailing fragment so a line split across two reads is
 * printed once, whole.
 */
async function followLog(logPath: string, opts: LogArgs): Promise<void> {
  let offset = statSync(logPath).size;
  // Bytes, not a string: the log carries →, ⚠️ and box-drawing
  // characters, so a chunk boundary can land mid-codepoint. Decoding
  // per chunk would turn those into replacement characters.
  let partial = Buffer.alloc(0);
  let running = true;

  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
      if (!running) break;

      let size: number;
      try {
        size = statSync(logPath).size;
      } catch {
        // Mid-rotation the path briefly does not exist. Wait it out
        // rather than exiting on a condition that resolves itself.
        continue;
      }

      if (size < offset) {
        // The file was rotated out from under us. Anything between the
        // old offset and the rotation is in agentbridge.log.1; the
        // honest thing is to say so rather than print a torn line.
        console.log("--- log rotated, continuing with the new file ---");
        offset = 0;
        partial = Buffer.alloc(0);
      }
      if (size === offset) continue;

      const chunk = readChunk(logPath, offset, size);
      if (chunk === null) continue;
      offset = offset + chunk.length;

      const buf = Buffer.concat([partial, chunk]);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        partial = buf;
        continue;
      }
      partial = buf.subarray(lastNewline + 1);
      for (const line of buf.subarray(0, lastNewline).toString("utf-8").split("\n")) {
        if (keepLine(line, opts)) console.log(formatLogLine(line));
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/** Read the byte range `[from, to)`, or null if the read fails. */
function readChunk(path: string, from: number, to: number): Buffer | null {
  const length = to - from;
  if (length <= 0) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do about a failed close */
      }
    }
  }
}

/**
 * Read at most the final `maxBytes` of a file as text.
 *
 * The first line of the result may be a fragment when the cap truncates
 * mid-line; it is dropped, because a half line of output looks like
 * corruption, and losing the oldest of several thousand lines costs the
 * reader nothing.
 */
function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  const from = Math.max(0, size - maxBytes);
  const chunk = readChunk(path, from, size);
  if (chunk === null) return "";
  const text = chunk.toString("utf-8");
  if (from === 0) return text;
  const firstNewline = text.indexOf("\n");
  return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
}
