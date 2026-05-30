import { describe, expect, test } from "bun:test";
import {
  detectShell,
  renderShellSnippet,
  resolveShell,
} from "../cli/shell-init";

describe("shell-init: detectShell()", () => {
  test("recognizes bash from full path", () => {
    expect(detectShell("/bin/bash")).toBe("bash");
  });

  test("recognizes zsh from full path", () => {
    expect(detectShell("/usr/local/bin/zsh")).toBe("zsh");
  });

  test("recognizes fish", () => {
    expect(detectShell("/usr/bin/fish")).toBe("fish");
  });

  test("recognizes plain sh", () => {
    expect(detectShell("/bin/sh")).toBe("sh");
  });

  test("returns null for unknown shell", () => {
    expect(detectShell("/usr/bin/nushell")).toBeNull();
  });

  test("returns null for undefined env", () => {
    expect(detectShell(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(detectShell("")).toBeNull();
  });
});

describe("shell-init: resolveShell()", () => {
  test("explicit arg overrides env", () => {
    expect(resolveShell({ shellArg: "fish", envShell: "/bin/bash" })).toBe("fish");
  });

  test("falls back to env when no arg", () => {
    expect(resolveShell({ envShell: "/bin/zsh" })).toBe("zsh");
  });

  test("normalizes uppercase arg", () => {
    expect(resolveShell({ shellArg: "BASH" })).toBe("bash");
  });

  test("rejects unsupported arg", () => {
    expect(() => resolveShell({ shellArg: "powershell" })).toThrow(/Unsupported shell/);
  });

  test("throws when no arg and undetectable env", () => {
    expect(() => resolveShell({ envShell: undefined })).toThrow(/Could not detect shell/);
  });
});

describe("shell-init: renderShellSnippet() — POSIX", () => {
  const bash = renderShellSnippet("bash");

  test("emits opening and closing markers", () => {
    expect(bash).toContain("# >>> agentbridge shell-init >>>");
    expect(bash).toContain("# <<< agentbridge shell-init <<<");
  });

  test("defines codex and claude wrapper functions", () => {
    expect(bash).toMatch(/^codex\(\)\s+\{/m);
    expect(bash).toMatch(/^claude\(\)\s+\{/m);
  });

  test("routes through `abg` only when --abg sentinel present", () => {
    // Function body must contain both `abg` (opt-in path) and `command codex`
    // (default native path).
    expect(bash).toContain("command abg ");
    expect(bash).toMatch(/command "\$native"/);
  });

  test("strips --abg sentinel before forwarding", () => {
    // No re-emit of --abg in the final command vector
    expect(bash).toContain('if [ "$arg" = "--abg" ]; then');
    expect(bash).toContain('bridge=1');
  });

  test("does not auto-detect daemon (opt-in only)", () => {
    // No pgrep — pure sentinel-driven
    expect(bash).not.toContain("pgrep");
  });

  test("zsh and sh share the same POSIX snippet", () => {
    const zsh = renderShellSnippet("zsh");
    const sh = renderShellSnippet("sh");
    expect(zsh).toBe(bash);
    expect(sh).toBe(bash);
  });

  test("snippet is idempotent across calls", () => {
    expect(renderShellSnippet("bash")).toBe(renderShellSnippet("bash"));
  });

  test("uses `command` builtin to bypass the function recursion", () => {
    // Without `command`, calling `codex` inside the `codex` function
    // would loop forever.
    expect(bash).toMatch(/command "\$native"/);
  });
});

describe("shell-init: renderShellSnippet() — fish", () => {
  const fish = renderShellSnippet("fish");

  test("uses fish syntax (function ... end)", () => {
    expect(fish).toMatch(/^function codex$/m);
    expect(fish).toMatch(/^function claude$/m);
    expect(fish).toMatch(/^end$/m);
  });

  test("uses fish-style argument handling", () => {
    expect(fish).toContain("$argv");
    expect(fish).toContain('test "$arg" = "--abg"');
  });

  test("differs from POSIX snippet", () => {
    expect(fish).not.toBe(renderShellSnippet("bash"));
  });

  test("does not auto-detect daemon (opt-in only)", () => {
    expect(fish).not.toContain("pgrep");
  });
});

describe("shell-init: behavioral validation — POSIX wrapper logic", () => {
  // Validate the emitted snippet works as advertised by sourcing it in a
  // child bash process with mocked `command`, `abg`, and `codex` binaries.
  test("`codex` (no --abg) invokes native codex", async () => {
    const result = await runMockedWrapper(["arg1", "arg2"]);
    expect(result.target).toBe("native:codex");
    expect(result.args).toEqual(["arg1", "arg2"]);
  });

  test("`codex --abg` invokes `abg codex`", async () => {
    const result = await runMockedWrapper(["--abg", "arg1"]);
    expect(result.target).toBe("abg:codex");
    expect(result.args).toEqual(["arg1"]);
  });

  test("`codex --abg resume --last` strips sentinel + passes rest", async () => {
    const result = await runMockedWrapper(["--abg", "resume", "--last"]);
    expect(result.target).toBe("abg:codex");
    expect(result.args).toEqual(["resume", "--last"]);
  });

  test("`codex --abg` at position 2 also triggers bridge", async () => {
    const result = await runMockedWrapper(["resume", "--abg", "--last"]);
    expect(result.target).toBe("abg:codex");
    expect(result.args).toEqual(["resume", "--last"]);
  });
});

/**
 * Source the emitted POSIX snippet in a child shell, mock both `command`
 * and the underlying binaries, then call `codex <args>` and capture which
 * target was invoked with which residual args.
 *
 * Returns { target: "native:codex" | "abg:codex", args: string[] }.
 */
async function runMockedWrapper(callArgs: string[]): Promise<{
  target: string;
  args: string[];
}> {
  const snippet = renderShellSnippet("bash");
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  const outFile = `${dir}/captured`;

  // Mock binaries — `command` will look them up via PATH but our wrapper
  // calls `command abg ...` and `command codex ...`. Easiest mock is to
  // shadow `command` inside the child shell.
  const script = `
${snippet}

# Mock the \`command\` builtin so wrapper calls land in our trap.
command() {
  local target="$1"; shift
  case "$target" in
    abg)
      local sub="$1"; shift
      printf 'abg:%s\\n' "$sub" > "${outFile}"
      printf '%s\\n' "$@" >> "${outFile}"
      ;;
    codex)
      printf 'native:codex\\n' > "${outFile}"
      printf '%s\\n' "$@" >> "${outFile}"
      ;;
    claude)
      printf 'native:claude\\n' > "${outFile}"
      printf '%s\\n' "$@" >> "${outFile}"
      ;;
    *)
      printf 'unknown:%s\\n' "$target" > "${outFile}"
      ;;
  esac
}

codex ${callArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}
`;

  const scriptFile = `${dir}/run.sh`;
  await Bun.write(scriptFile, script);
  await Bun.$`bash ${scriptFile}`.quiet();

  const captured = (await Bun.file(outFile).text()).trim().split("\n");
  const target = captured[0] ?? "";
  const args = captured.slice(1).filter((s) => s.length > 0);
  await Bun.$`rm -rf ${dir}`.quiet();
  return { target, args };
}

describe("shell-init: behavioral validation — fish wrapper logic", () => {
  test("fish snippet parses without syntax errors", async () => {
    const fish = renderShellSnippet("fish");
    // Only run if fish is installed
    const hasFish = await Bun.$`command -v fish`.quiet().then(() => true).catch(() => false);
    if (!hasFish) {
      console.log("[skip] fish not installed; skipping fish parse check");
      return;
    }
    // `fish -n` does syntax-check only
    const result = await Bun.$`echo ${fish} | fish -n`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });
});
