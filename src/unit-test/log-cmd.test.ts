import { describe, expect, test } from "bun:test";
import { formatLogLine, keepLine, parseLogArgs } from "../cli/log-cmd";

const DAEMON = "[2026-07-14T03:21:58.493Z] [AgentBridgeDaemon] ";
const CODEX = "[2026-07-14T03:21:56.973Z] [CodexAdapter] ";

describe("parseLogArgs", () => {
  test("defaults to a filtered, non-following tail", () => {
    expect(parseLogArgs([])).toEqual({ lines: 40, follow: false, all: false, grep: null });
  });

  test("accepts both spellings of each flag", () => {
    expect(parseLogArgs(["-f"]).follow).toBe(true);
    expect(parseLogArgs(["--follow"]).follow).toBe(true);
    expect(parseLogArgs(["-a"]).all).toBe(true);
    expect(parseLogArgs(["--all"]).all).toBe(true);
    expect(parseLogArgs(["-n", "5"]).lines).toBe(5);
    expect(parseLogArgs(["--lines", "5"]).lines).toBe(5);
  });

  test("flags combine", () => {
    const parsed = parseLogArgs(["-n", "100", "--follow", "--all"]);
    expect(parsed).toEqual({ lines: 100, follow: true, all: true, grep: null });
  });

  test("--grep compiles a case-insensitive pattern", () => {
    const parsed = parseLogArgs(["--grep", "FORWARDING"]);
    expect(parsed.grep?.test("Forwarding Claude → Codex")).toBe(true);
  });

  // Bad input is rejected rather than defaulted: silently showing 40
  // lines for `-n banana` is the kind of thing that costs ten minutes.
  test("rejects a non-numeric line count", () => {
    expect(() => parseLogArgs(["-n", "banana"])).toThrow(/positive integer/);
  });

  test("rejects a zero or negative line count", () => {
    expect(() => parseLogArgs(["-n", "0"])).toThrow(/positive integer/);
    expect(() => parseLogArgs(["-n", "-5"])).toThrow(/positive integer/);
  });

  test("rejects a missing line count", () => {
    expect(() => parseLogArgs(["-n"])).toThrow(/positive integer/);
  });

  test("rejects a missing or invalid grep pattern", () => {
    expect(() => parseLogArgs(["--grep"])).toThrow(/needs a pattern/);
    expect(() => parseLogArgs(["--grep", "([unclosed"])).toThrow(/not a valid regex/);
  });

  test("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseLogArgs(["--tail"])).toThrow(/Unknown option/);
  });
});

describe("keepLine", () => {
  const filtered = { all: false, grep: null };

  test("keeps message-flow lines", () => {
    expect(keepLine(`${DAEMON}Forwarding Claude → Codex (42 chars)`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}Queued Claude → Codex reply while turn in progress`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}Delivered queued reply reply_1 after turn completion`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}Injection rejected: no active thread`, filtered)).toBe(true);
  });

  test("keeps attach / lifecycle transitions", () => {
    expect(keepLine(`${DAEMON}Claude frontend attached (#1)`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}Claude frontend detached (#1, socket closed)`, filtered)).toBe(true);
    expect(keepLine(`${CODEX}Codex TUI connected (conn #1)`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}Codex turn completed`, filtered)).toBe(true);
  });

  test("keeps errors and warnings whatever component they came from", () => {
    expect(keepLine(`${CODEX}[codex-server] ERROR failed to refresh models`, filtered)).toBe(true);
    expect(keepLine(`${DAEMON}⚠️ Reply was required but Codex did not send one`, filtered)).toBe(true);
  });

  test("drops routine bookkeeping", () => {
    expect(keepLine(`${DAEMON}Starting AgentBridge daemon...`, filtered)).toBe(false);
    expect(keepLine(`${CODEX}  listening on: ws://127.0.0.1:17035`, filtered)).toBe(false);
    expect(keepLine("", filtered)).toBe(false);
  });

  test("--all keeps everything except blank lines", () => {
    const all = { all: true, grep: null };
    expect(keepLine(`${DAEMON}Starting AgentBridge daemon...`, all)).toBe(true);
    expect(keepLine("   ", all)).toBe(false);
  });

  test("--grep replaces the default filter rather than narrowing it", () => {
    // A pattern the user typed is a deliberate request; intersecting it
    // with the built-in filter would silently hide matches.
    const grep = { all: false, grep: /Starting AgentBridge/i };
    expect(keepLine(`${DAEMON}Starting AgentBridge daemon...`, grep)).toBe(true);
    expect(keepLine(`${DAEMON}Codex turn completed`, grep)).toBe(false);
  });
});

describe("formatLogLine", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  test("renders same-day entries as local wall-clock time", () => {
    const line = `[2026-07-14T03:21:58.493Z] [AgentBridgeDaemon] Claude frontend attached (#1)`;
    const out = formatLogLine(line, now);
    const local = new Date("2026-07-14T03:21:58.493Z");
    const pad = (n: number) => String(n).padStart(2, "0");

    expect(out).toContain(`${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`);
    expect(out).toContain("daemon");
    expect(out).toContain("Claude frontend attached (#1)");
    expect(out).not.toContain("2026-07-14T");
  });

  test("keeps the date on entries from another day", () => {
    const out = formatLogLine(`[2026-07-10T03:21:58.493Z] [CodexAdapter] Codex ready`, now);
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+codex\s+Codex ready$/);
  });

  test("shortens each component to the side of the bridge it is", () => {
    expect(formatLogLine(`${DAEMON}x`, now)).toContain("daemon");
    expect(formatLogLine(`[2026-07-14T03:00:00.000Z] [AgentBridgeFrontend] x`, now)).toContain("bridge");
    expect(formatLogLine(`${CODEX}x`, now)).toContain("codex");
    expect(formatLogLine(`[2026-07-14T03:00:00.000Z] [ClaudeAdapter] x`, now)).toContain("claude");
  });

  test("passes an unrecognized component through lowercased", () => {
    expect(formatLogLine(`[2026-07-14T03:00:00.000Z] [SomethingNew] x`, now)).toContain("somethingnew");
  });

  // An unparsed line is still worth seeing — reformatting must never be
  // able to swallow output it did not understand.
  test("passes lines that do not match the log shape through untouched", () => {
    expect(formatLogLine("no timestamp here", now)).toBe("no timestamp here");
    expect(formatLogLine("--- end stderr ---", now)).toBe("--- end stderr ---");
  });

  test("passes through a line whose timestamp does not parse", () => {
    const line = "[2026-13-45T99:99:99.999Z] [AgentBridgeDaemon] x";
    expect(formatLogLine(line, now)).toBe(line);
  });

  test("keeps multi-line message bodies intact", () => {
    const line = `${DAEMON}exit: code=1\n--- last stderr ---\nboom`;
    expect(formatLogLine(line, now)).toContain("--- last stderr ---\nboom");
  });
});
