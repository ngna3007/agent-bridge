# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Publishing note.** The latest version on npm is `0.6.3`. Versions
> `0.6.4` through `0.6.8` were developed and tagged in the repository but
> never published, so the next publish will carry all of them at once.

## [Unreleased]

Work merged to `master` after the `0.6.8` version bump, plus two feature
branches still in review. Cutting a release from here means a minor bump
(`0.7.0`) because of the two features.

### Added

- **Editable agent roles.** Agent instructions are no longer compiled-in
  constants. `abg init` seeds `.agentbridge/roles/claude.md` and
  `.agentbridge/roles/codex.md`; the file body *is* the role text, with
  no format to learn and no parser to fight. Every launch re-renders the
  marked block in `CLAUDE.md` / `AGENTS.md` from those files, which
  resolves the old trap where the one place a user would naturally edit
  was also the one place that got overwritten. New `abg roles` command
  (`list` / `edit` / `apply` / `reset` / `path`), role findings in `abg
  doctor`, and a warning when an edited role drops a routing marker the
  built-in default relied on. (PR #5)
- **Setup offered on first run.** Without a `.agentbridge/` marker,
  `abg claude` silently fell back to single-instance mode — fixed ports,
  a shared state dir, no collaboration section. It worked, which was the
  problem: the second project launched that way took the daemon slot
  from the first. AgentBridge now offers to set the project up on the
  first `abg claude` / `abg codex` in an unconfigured directory. The
  target is the git root rather than the cwd, and a decline is
  remembered per directory so the question is asked exactly once. (PR #4)
- **Headless live-test tiers.** `src/live-test/tier2-bridge-e2e.ts`
  drives the entire bridge without a terminal. The Claude→Codex
  direction was previously untestable in CI because
  `CodexAdapter.injectMessage` needs a `threadId` that only the Codex
  TUI's handshake produces — the harness now speaks that handshake
  itself. `src/live-test/tier3-roles.sh` proves an edited role file
  changes what a real agent actually does. Both spend real model tokens,
  so they run via `bun run test:live:bridge` / `test:live:roles` rather
  than `bun test src`. `docs/test-plan.md` maps the five tiers.

### Fixed

- `[REPLY]` marker identity is preserved in `full` filter mode.
  `classifyMessage()` hard-coded `marker: "untagged"` there, discarding
  what `parseMarker()` had already resolved, so a correctly-tagged Codex
  `[REPLY]` never satisfied `require_reply` and the daemon emitted a
  spurious `system_reply_missing` at the end of every such turn. The
  mode now selects *routing*, never *identity*. (#2)
- `syncRoleSections` no longer treats an unreadable instruction file as
  an empty one. The read was wrapped in a bare `catch`, so `EACCES` or
  `EISDIR` on `CLAUDE.md` produced `existing = ""` and the next write
  replaced the user's entire file with just the AgentBridge block. Only
  `ENOENT` now means "create it"; every other read error skips the
  agent and reports why.
- `abg roles edit` quotes the role file path. `$EDITOR` is run through a
  shell (it is conventionally a command line — `code --wait` — not a
  bare binary), and the unquoted path meant any project root containing
  a space opened the wrong files.
- `abg roles apply` warns about dropped routing markers. The warning
  existed only at launch and in `abg doctor`, so the natural sequence —
  edit the role, apply, wonder why the bridge went quiet — was the one
  path that stayed silent.
- Tier 3's `T3.6` assertion could not fail: it refuted a token that an
  earlier step had already replaced. It now asserts that the previous
  role text survived the aborted render, which is the actual claim.
- Codex's default role no longer contradicts itself. `AGENTS_MD_SECTION`
  shipped both "you are the Advisor / Reviewer, you do NOT ship the
  change" and "Default role: Implementer, Executor, Verifier" in the
  same generated section — the contract and its negation in one system
  prompt, with the winner left to the model. (#1)

### Changed

- Documentation is English-only; README and `CLAUDE.md` refreshed for
  the multi-project model. (#3)
- Plugin manifests realigned to `package.json`. `plugin.json` and
  `marketplace.json` had been left at `0.1.6` against a `0.6.8`
  package, so `bun run check` failed its version gate and an installed
  plugin reported the wrong version.

## [0.6.8]

### Fixed

- **macOS orphan reaping was effectively a no-op.** `findPidsByEnv`
  split the `ps` line on whitespace and looked for an exact token, but
  the default macOS state dir lives under `~/Library/Application
  Support/AgentBridge` — the env entry tokenizes into three pieces and
  the needle is never found. Even a matched pid would then have been
  dropped, because `getParentPid` only read `/proc` and returned null on
  macOS. Now uses `ps -Eww` with boundary-anchored matching (robust to
  spaces in the value, since only the boundaries matter) and falls back
  to `ps -p <pid> -o ppid=` for the parent lookup.
- Orphan classification is now a pure predicate,
  `isOrphanBridgeServer({ envMatch, cmd, ppid, parentAlive })`, with 10
  unit tests covering every guard including the "ppid unknown → err on
  caution" default. `findOrphanBridgeServers` is a thin wrapper that
  fills the inputs from the system.

## [0.6.7]

### Fixed

- **`abg status` / `abg doctor` read the wrong state dir in project
  mode.** Both constructed `new StateDirResolver()` and landed on the
  platform default while the daemon they were inspecting ran under
  `<root>/<projectId>/` — so `abg status` could report "not running"
  with a live pid file sitting one directory away. New
  `src/runtime-namespace.ts` is the single resolver every command goes
  through: launch commands apply the per-project env, read-only
  commands just compute the right state dir and control port.
- **`abg kill` could SIGTERM the wrong process.** Matching on
  `AGENTBRIDGE_STATE_DIR` alone meant the daemon itself, or a Codex
  child that inherited the env, could be misclassified as an orphan
  bridge-server. Classification now requires env match *and* a
  `bridge-server` command line that is neither `daemon.js` nor `codex`
  *and* a dead-or-reparented parent.
- Env matching in `findPidsByEnv` was a substring test against the raw
  env blob, so `AGENTBRIDGE_STATE_DIR=/x` false-matched
  `OLD_AGENTBRIDGE_STATE_DIR=/x`. The `/proc` path now splits on NUL.

## [0.6.6]

### Added

- `abg projects` — lists every project state dir under the platform root
  with daemon status (running / stale / stopped / not-running) and its
  last statusbar tag, running-first. Read-only.
- `abg doctor` — diagnoses the stuck states that kept recurring: stale
  `daemon.pid`, orphan bridge-server pids, stale `startup.lock`, ports
  actually in use, port mismatch between `.agentbridge/config.json` and
  the project-id derivation, and legacy `AGENTBRIDGE_PIN_CONTRACT` mode.
  Each finding prints a copy-pasteable fix. Read-only.
- `abg kill --all` — sweeps every state dir under the platform root, not
  just the current project.
- Orphan reaping in `abg kill`, via the new `src/process-helpers.ts`. An
  orphan is defined precisely: a bridge-server process whose state dir
  matches ours *and* whose parent is gone or reparented to pid 1. The
  parent-alive guard keeps `abg kill` from stomping a bridge that is
  still attached to a live Claude session.

### Fixed

- The statusbar no longer goes stale on shutdown. `daemon.shutdown()`
  writes `[BRIDGE STOPPED]` to `status.line` *before* tearing down the
  control server — when daemon and bridge die together, the bridge
  cannot emit it on its own and the user was left staring at a stale
  `[CODEX READY]`.

## [0.6.5]

### Changed

- **Review framing, to break the shared-frame failure mode.** Two AI
  reviewers are not automatically two independent perspectives. In a
  real session both Claude and Codex caught local correctness bugs and
  both missed that a production-defining rule had been copy-pasted into
  four places; the human reviewer saw it immediately. Codex's own
  post-mortem: *"I treated duplication as acceptable … I should have
  said: this should be single-sourced because it defines production
  serving, risky even if currently identical."* The fix is at the prompt
  layer — Codex now runs review in a fixed order (local correctness →
  single source of truth → fresh-eyes → author blind-spot), and Claude
  is told to ask for structure and invariants rather than "is each piece
  correct?", and not to pre-narrate its own audit, which anchors Codex.

## [0.6.4]

### Added

- **Multi-project support via per-project namespacing.** The
  single-instance model (fixed ports 4500/4501/4502, one state dir)
  forced one Claude slot per machine — a second `abg claude` was
  rejected with `[ANOTHER SESSION ACTIVE]`. `src/project-id.ts` now
  walks up from the cwd for a `.agentbridge/` marker, hashes the
  absolute root to an 8-hex project id, and derives three sequential
  ports from a 1000-slot pool (14500–17499). State nests under
  `<default>/<projectId>/`. Explicit env vars still win, and a directory
  with no marker keeps the historical defaults, so existing setups are
  unaffected.
- Queue `[STATUS]` summary.
