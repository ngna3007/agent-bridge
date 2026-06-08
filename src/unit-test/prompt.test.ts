import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { arrowPicker, type PickerOption } from "../cli/prompt";

/**
 * Tests use PassThrough streams to simulate stdin/stdout. The picker
 * accepts `forceInteractive: true` to bypass TTY detection.
 *
 * Mock stdin must expose setRawMode/isTTY for the picker to treat it as
 * a terminal. We patch them onto the PassThrough.
 */

interface MockStdin extends PassThrough {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode: (raw: boolean) => MockStdin;
}

interface MockStdout extends PassThrough {
  isTTY?: boolean;
  output: string;
}

// The picker accepts any object structurally compatible with the few
// stream methods it touches (write/on/removeListener/setRawMode), so we
// hand it our PassThrough-based mocks via `as any` to avoid pulling in
// the full Node.js ReadStream / WriteStream type surface.
function mockStdin(): any {
  const s = new PassThrough() as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (raw: boolean) => {
    s.isRaw = raw;
    return s;
  };
  return s;
}

function mockStdout(): any {
  const s = new PassThrough() as MockStdout;
  s.isTTY = false; // turn off TTY here so colors are disabled by default
  s.output = "";
  s.on("data", (chunk: Buffer) => {
    s.output += chunk.toString("utf8");
  });
  return s;
}

const OPTIONS: PickerOption[] = [
  { value: "a", label: "Alpha", description: "first option" },
  { value: "b", label: "Beta", description: "second option" },
  { value: "c", label: "Gamma" },
];

describe("arrowPicker - non-interactive fallback", () => {
  test("returns default value when stdin is not a TTY", async () => {
    const s = new PassThrough();
    const out = new PassThrough();
    const result = await arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 1,
      stdin: s as any,
      stdout: out as any,
      // Do NOT set forceInteractive - let it detect non-TTY.
    });
    expect(result).toBe("b");
  });

  test("returns default value when stdout is not a TTY", async () => {
    const s = mockStdin();
    const out = new PassThrough();
    const result = await arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 2,
      stdin: s as any,
      stdout: out as any,
    });
    expect(result).toBe("c");
  });

  test("clamps out-of-range defaultIndex", async () => {
    const result = await arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 99,
      stdin: new PassThrough() as any,
      stdout: new PassThrough() as any,
    });
    expect(result).toBe("c");
  });

  test("throws on empty options", () => {
    expect(() => arrowPicker({
      title: "Pick one",
      options: [],
      stdin: new PassThrough() as any,
      stdout: new PassThrough() as any,
    })).toThrow();
  });
});

describe("arrowPicker - interactive selection", () => {
  test("Enter on default index returns the default value", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\r"));
    expect(await promise).toBe("a");
  });

  test("Down arrow then Enter advances one", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x1b[B\r"));
    expect(await promise).toBe("b");
  });

  test("Up arrow wraps around from index 0 to end", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x1b[A\r"));
    expect(await promise).toBe("c");
  });

  test("Down arrow wraps around at end", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 2,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x1b[B\r"));
    expect(await promise).toBe("a");
  });

  test("vim-style j/k navigation works", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("jj\r"));
    expect(await promise).toBe("c");
  });

  test("digit shortcut selects and confirms immediately", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("2"));
    expect(await promise).toBe("b");
  });

  test("digit out of range is ignored", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      defaultIndex: 0,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("9\r")); // 9 is out of range → ignored, Enter confirms default
    expect(await promise).toBe("a");
  });
});

describe("arrowPicker - cancellation", () => {
  test("Esc returns null", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x1b"));
    expect(await promise).toBeNull();
  });

  test("Ctrl-C returns null", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x03"));
    expect(await promise).toBeNull();
  });
});

describe("arrowPicker - rendering", () => {
  test("title and hint appear in output", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
      noColor: true,
    });
    setImmediate(() => stdin.write("\r"));
    await promise;
    expect(stdout.output).toContain("Pick one");
    expect(stdout.output).toContain("Esc to cancel");
  });

  test("example block appears between header and options", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      example: "demo line 1\ndemo line 2",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
      noColor: true,
    });
    setImmediate(() => stdin.write("\r"));
    await promise;
    expect(stdout.output).toContain("demo line 1");
    expect(stdout.output).toContain("demo line 2");
    // Example is rendered before option labels.
    expect(stdout.output.indexOf("demo line 1")).toBeLessThan(stdout.output.indexOf("Alpha"));
  });

  test("all option labels appear in the initial render", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
      noColor: true,
    });
    setImmediate(() => stdin.write("\r"));
    await promise;
    expect(stdout.output).toContain("Alpha");
    expect(stdout.output).toContain("Beta");
    expect(stdout.output).toContain("Gamma");
    expect(stdout.output).toContain("first option");
  });

  test("noColor=true suppresses ANSI color codes (selection marker still ASCII)", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
      noColor: true,
    });
    setImmediate(() => stdin.write("\r"));
    await promise;
    // No SGR (color/bold/dim) escape sequences.
    expect(stdout.output).not.toMatch(/\x1b\[(?:0|1|2|32|36|33)m/);
  });

  test("cursor cleanup: raw mode is restored after Enter", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\r"));
    await promise;
    expect(stdin.isRaw).toBe(false);
  });

  test("cursor cleanup: raw mode is restored after cancel", async () => {
    const stdin = mockStdin();
    const stdout = mockStdout();
    const promise = arrowPicker({
      title: "Pick one",
      options: OPTIONS,
      stdin,
      stdout,
      forceInteractive: true,
    });
    setImmediate(() => stdin.write("\x03"));
    await promise;
    expect(stdin.isRaw).toBe(false);
  });
});
