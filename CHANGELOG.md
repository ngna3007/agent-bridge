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
- **Replies sent during a Codex turn are held, not rejected.** Codex
  accepts one turn at a time, so `reply` during a running turn used to
  fail outright and the only recovery was for Claude to notice and
  resend by hand — which it frequently did not, and which produced
  duplicates when it did. The daemon now holds the message in a small
  outbox (`src/reply-outbox.ts`) and injects it the moment the turn
  ends. The tool result says "queued", not "sent" and not "failed", so
  Claude can tell the difference without guessing. The outbox is
  bounded and perishable — three messages and ten minutes by default,
  tunable with `AGENTBRIDGE_REPLY_QUEUE_MAX` and
  `AGENTBRIDGE_REPLY_QUEUE_TTL_MS` — and every drop, expiry, or
  undeliverable message is reported to Claude with the original text
  echoed back. Nothing is discarded silently.
- **`abg status` asks the running daemon.** It previously read only
  files, which record what was true when the daemon booted, so it could
  not answer the question people actually open it for: is the other
  agent there right now? It now queries `/healthz` and reports whether
  Claude is attached, whether the Codex TUI is connected, whether a
  thread exists yet, and how many messages are queued or held — each
  with the command that fixes it. The port comes from `status.json`
  rather than being re-derived, because a config edit or a moved
  project root would otherwise make a healthy daemon look dead.
- **`abg doctor --fix` repairs what it diagnoses.** The doctor could
  spot a stale `daemon.pid`, an abandoned `startup.lock`, an orphaned
  bridge server, or drifted config ports, and then leave the user to
  work out the `rm`. `--fix` repairs those four. Each re-verifies its
  evidence at repair time rather than trusting the diagnosis, since the
  report can sit on screen while the state changes underneath it, and
  repairs are attached only to findings whose bad state was *proved* —
  never to ones that were inferred.
- **`abg log` shows what crossed the bridge.** There was no way to see
  the traffic short of tailing the raw log and reading around the
  startup noise. `abg log` prints a filtered, reformatted tail —
  forwards, queues, injections, turn boundaries, attach/detach, and
  every error — with `-f` to follow (rotation-aware), `-n` for depth,
  `--grep` for a pattern, and `--all` to drop the filter.
- **Codex sees a launch summary.** The Codex side had no statusbar, no
  push notifications, and no way to ask the bridge anything from inside
  the TUI, so a Codex user could not tell whether Claude was even
  attached. `abg codex` now prints a short banner before the TUI takes
  the screen: whether Claude is attached, how many messages are waiting,
  what `[REPLY]` / `[STATUS]` / `[FYI]` do, and which commands answer
  follow-up questions.
- **Coverage for terminal restore.** `src/cli/terminal-restore.ts` lifts
  the save/restore out of `abg codex` behind an injected syscall seam,
  with 12 tests. This is the code that rescues a shell after the Codex
  TUI dies without cleaning up — no echo, no cursor, stuck in the
  alternate screen — and it had no coverage at all, because none of it
  is reachable from a test runner: no TTY, `stty` fails, `/dev/tty` will
  not open. The fallbacks are now assertable: `stty sane` when the saved
  state is rejected, stdout when `/dev/tty` is unavailable, no writes at
  all when stdout is a pipe, and the remaining sequences still sent
  after one write fails. `stty` also moved from `execSync` with an
  interpolated command string to `execFileSync` with an argv array.

### Fixed

- **A port-slot collision between two projects killed one of their
  Codex sessions.** Project ids are hashed into 1000 port slots, so two
  projects can derive the same triple — about 4% likely at ten projects
  on a machine, 17% at twenty. When that happened, the second daemon to
  start ran its stale-port cleanup, found the *other* project's live
  `codex app-server`, matched it with a command-line test
  (`includes("codex") && includes("app-server")`), classified it as its
  own orphan, and killed it. The test could not have worked: a
  collision means the port matches too, so both processes have
  byte-identical command lines. The daemon now records the pid of the
  app-server it spawns and kills only that pid; anything else on the
  port is reported and left alone, with an error naming the likely
  collision. `abg doctor` reports colliding projects directly, as an
  error when the other daemon is live. `ps` and `kill` in that path
  moved off the shell to `execFileSync` / `process.kill` with a
  validated numeric pid.
- **A colliding project could attach to another project's daemon, and
  its Claude would drive the wrong Codex.** The refusal above stops the
  second *daemon* from binding a taken port; nothing stopped the second
  *frontend* from using the daemon it found there. `isHealthy()` was
  `fetch(/healthz).ok` with no identity in it, so a colliding project
  decided the other project's daemon was its own, skipped launching,
  and wired its Claude to a Codex running in an unrelated repo — with
  no error on either side. Reproduced at the data level: a reply sent
  by the second project was accepted and forwarded by the first
  project's daemon. `/healthz` now reports `projectId`, health and
  readiness probes refuse a daemon that belongs to someone else, and
  the daemon closes a frontend from another project with
  `CLOSE_CODE_PROJECT_MISMATCH` rather than serving it. A daemon that
  reports no id at all is still accepted, so upgrading does not orphan
  one that is already running.
- **Every health probe could hang for over two minutes.** A `fetch` to
  a port nothing listens on is fast only when the host answers with
  RST. Where the SYN is dropped instead — WSL2 behind the default
  Windows firewall does exactly this — connect() runs out the kernel's
  SYN-retry budget first: measured at **141 seconds** per probe, before
  `ensureRunning` even tries to launch the daemon, and turning
  `waitForReady`'s 40 retries into over an hour of a session hanging
  with no explanation. Probes now carry their own deadline (1.5s), as
  does the control-socket connect in `DaemonClient` (5s). A probe is a
  question about a local process; if it cannot be answered in a second
  and a half, the answer is no.
- **A taken control port produced `Failed to start server. Is port
  17843 in use?`** — an uncaught `Bun.serve` exception naming neither
  the holder nor the fix, while the message that explains port slots
  sat further down a startup path the daemon never reached. Both the
  daemon and `ensureRunning` now ask who holds the port before binding
  it, and fail with a message that names the holding project, its pid,
  why two projects can share a slot, and the two ways out.
- **The daemon exited 0 after failing to start.** Anything fatal during
  startup — a lost bind race, an unbindable port — was reported to the
  log and then left the process to exit successfully, so a supervisor,
  a launcher, or a script saw a clean shutdown rather than a failure.
  A startup failure now exits 1.
- **Upgrading overwrote hand-edited role text.** Before 0.7 the marked
  block in `CLAUDE.md` / `AGENTS.md` *was* the role, and editing it in
  place was the documented way to change what an agent is told. On the
  first launch after upgrading, `syncRoleSections` rendered
  `.agentbridge/roles/<agent>.md` — freshly seeded from the built-in
  default — straight over that text, with no warning and nothing to
  recover from. Both `abg init` and every launch now adopt an existing
  marked block into the role file when the role file does not exist
  yet, and say where the text went. Only a missing role file is
  adopted into; an existing one is never touched.
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
- `abg init` no longer aborts halfway through on an unusable role file.
  `writeCollaborationSections` threw, and it runs *after* `config.json`
  is written and *before* the plugin install — so a blank role file left
  a half-made project and skipped the other agent's section for a
  problem unrelated to it. It now renders one agent at a time, reports
  the bad one, finishes the rest, and exits non-zero with the file to
  fix.
- `abg claude` says something when setup succeeds but the namespace does
  not resolve. `maybeOfferSetup`'s return value was discarded, so the
  one case it was there to catch — the user answers "yes" and still gets
  the shared ports — was indistinguishable from a normal unconfigured
  launch.
- Tier 2's turn detection accepted a `turn/completed` from an earlier
  turn paired with a `turn/started` from one still running. It now
  requires the completion to come *after* the start, which is the state
  the harness is actually in between steps.

- Codex's default role no longer contradicts itself. `AGENTS_MD_SECTION`
  shipped both "you are the Advisor / Reviewer, you do NOT ship the
  change" and "Default role: Implementer, Executor, Verifier" in the
  same generated section — the contract and its negation in one system
  prompt, with the winner left to the model. (#1)

### Changed

- **"Wait for `✅ Codex finished` before replying" is no longer a rule.**
  It was a human-enforced workaround for the busy guard, documented in
  `CLAUDE.md` and in Claude's own instructions, and it depended on an
  agent watching a statusbar tag it has no reliable way to observe.
  The outbox enforces the same ordering mechanically, so the guidance
  is now the opposite: reply when you have something to say, and do
  *not* resend.
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
