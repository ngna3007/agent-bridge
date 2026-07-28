import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { decideSetupOffer, findGitRoot, type SetupOfferContext } from "../cli/auto-setup";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "abg-autosetup-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Baseline context that WOULD produce an offer; tests override one field. */
function ctx(overrides: Partial<SetupOfferContext> = {}): SetupOfferContext {
  return {
    command: "claude",
    cwd: root,
    isInteractive: true,
    hasDeclined: () => false,
    findGitRoot: () => null,
    ...overrides,
  };
}

describe("decideSetupOffer", () => {
  test("offers for an unconfigured directory under a setup-aware command", () => {
    const d = decideSetupOffer(ctx());
    expect(d.offer).toBe(true);
    if (d.offer) {
      expect(d.targetDir).toBe(root);
      expect(d.cwdIsTarget).toBe(true);
    }
  });

  test.each(["claude", "codex"])("offers for `%s`", (command) => {
    expect(decideSetupOffer(ctx({ command })).offer).toBe(true);
  });

  // The offer must never fire for commands that deliberately skip the
  // namespace — creating a marker from `abg init` would recurse, and
  // creating one from `--version` would be absurd.
  test.each(["init", "dev", "status", "projects", "doctor", "kill", "--help", "--version"])(
    "stays silent for `%s`",
    (command) => {
      const d = decideSetupOffer(ctx({ command }));
      expect(d.offer).toBe(false);
      if (!d.offer) expect(d.reason).toBe("not-setup-aware-command");
    },
  );

  test("stays silent when no command was given", () => {
    const d = decideSetupOffer(ctx({ command: undefined }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("not-setup-aware-command");
  });

  test("stays silent when the directory is already a project", () => {
    mkdirSync(join(root, ".agentbridge"));
    const d = decideSetupOffer(ctx());
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("already-a-project");
  });

  test("stays silent when an ANCESTOR is already a project", () => {
    mkdirSync(join(root, ".agentbridge"));
    const child = join(root, "packages", "web");
    mkdirSync(child, { recursive: true });
    const d = decideSetupOffer(ctx({ cwd: child }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("already-a-project");
  });

  // Never write files in a pipe, a CI job, or a headless harness.
  test("stays silent when not interactive", () => {
    const d = decideSetupOffer(ctx({ isInteractive: false }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("non-interactive");
  });

  test.each(["0", "false", "no", "FALSE", "No"])(
    "stays silent when AGENTBRIDGE_AUTO_SETUP=%s",
    (value) => {
      const d = decideSetupOffer(ctx({ autoSetupEnv: value }));
      expect(d.offer).toBe(false);
      if (!d.offer) expect(d.reason).toBe("opted-out-by-env");
    },
  );

  test.each(["1", "true", "yes", ""])("still offers when AGENTBRIDGE_AUTO_SETUP=%s", (value) => {
    expect(decideSetupOffer(ctx({ autoSetupEnv: value })).offer).toBe(true);
  });

  test("stays silent once the directory has been declined", () => {
    const d = decideSetupOffer(ctx({ hasDeclined: (dir) => dir === root }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("previously-declined");
  });

  test("a decline for a DIFFERENT directory does not suppress this one", () => {
    expect(decideSetupOffer(ctx({ hasDeclined: (dir) => dir === "/somewhere/else" })).offer).toBe(true);
  });

  test("refuses the home directory", () => {
    const d = decideSetupOffer(ctx({ cwd: homedir() }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("unsafe-location");
  });

  test("refuses the filesystem root", () => {
    const d = decideSetupOffer(ctx({ cwd: "/" }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("unsafe-location");
  });

  // Running `abg claude` from src/ must not root the project at src/ —
  // the sibling tests/ would then resolve to a different project.
  test("targets the git root, not the cwd, when inside a repo", () => {
    const sub = join(root, "src", "cli");
    mkdirSync(sub, { recursive: true });
    const d = decideSetupOffer(ctx({ cwd: sub, findGitRoot: () => root }));
    expect(d.offer).toBe(true);
    if (d.offer) {
      expect(d.targetDir).toBe(root);
      expect(d.cwdIsTarget).toBe(false);
    }
  });

  test("declining the git root suppresses the offer from a subdirectory too", () => {
    const sub = join(root, "src");
    mkdirSync(sub, { recursive: true });
    const d = decideSetupOffer(
      ctx({ cwd: sub, findGitRoot: () => root, hasDeclined: (dir) => dir === root }),
    );
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("previously-declined");
  });

  // Checks are ordered cheapest-and-most-decisive first; an existing
  // project must win over a non-interactive shell so the reason
  // reported to a debugging user is the useful one.
  test("already-a-project outranks non-interactive", () => {
    mkdirSync(join(root, ".agentbridge"));
    const d = decideSetupOffer(ctx({ isInteractive: false }));
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("already-a-project");
  });

  test("the project lookup is injectable", () => {
    // The real lookup walks up from cwd, so a checkout that is itself an
    // AgentBridge project would answer "already-a-project" for every
    // path a test could pass. Overriding it keeps the decision under the
    // test's control rather than the working directory's.
    const seen: string[] = [];
    const d = decideSetupOffer(
      ctx({
        findExistingProject: (from) => {
          seen.push(from);
          return "/elsewhere/some-other-project";
        },
      }),
    );

    expect(seen).toEqual([root]);
    expect(d.offer).toBe(false);
    if (!d.offer) expect(d.reason).toBe("already-a-project");
  });
});

describe("findGitRoot", () => {
  test("finds the repo root from a nested directory", () => {
    mkdirSync(join(root, ".git"));
    const sub = join(root, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(root);
  });

  test("returns the directory itself when it is the repo root", () => {
    mkdirSync(join(root, ".git"));
    expect(findGitRoot(root)).toBe(root);
  });

  test("treats a .git FILE (worktree / submodule) as a root", () => {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(findGitRoot(root)).toBe(root);
  });

  test("returns null outside any repo", () => {
    const sub = join(root, "plain");
    mkdirSync(sub);
    // tmpdir() is not inside a git repo on any supported platform.
    expect(findGitRoot(sub)).toBe(null);
  });
});
