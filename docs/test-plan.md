# AgentBridge test plan

What we test, at which level, and which parts a machine can run without a
human at a terminal.

This document is the map. Two other files are the territory:

- `docs/manual-test-plan.md` — the long-form manual procedure (8 phases,
  two terminals). Tier 4 below points at it rather than repeating it.
- `src/live-test/` — the harnesses for Tiers 2 and 3.

## The shape of the problem

AgentBridge is three processes with a human normally standing in the
middle of two of them:

```
Claude Code ──MCP stdio──▶ bridge.ts ──control WS──▶ daemon.ts ──WS proxy──▶ codex app-server
```

The awkward part is the Codex side. `CodexAdapter.injectMessage` returns
false unless `this.threadId` is set, and the only writers of that field
are the handlers for the `thread/start`, `thread/resume`, and
`turn/start` responses. Those responses exist because a Codex TUI
performed a handshake. No TUI means no thread id, which means the
Claude→Codex direction cannot be exercised at all.

That single fact is why the bridge's most important path lived in a
manual checklist for so long. Tier 2 resolves it by having the harness
speak the TUI's protocol itself, which turns out to be enough — the
adapter does not care whether a terminal is attached, only that the
handshake traffic went past.

## Tiers

| Tier | What it proves | Headless | Runs today | Cost |
|---|---|---|---|---|
| 0 | Unit — pure logic, adapters against fakes | yes | `bun test src` | seconds |
| 1 | CLI integration — commands, setup, namespacing | yes | `bun test src` | seconds |
| 2 | Full bridge E2E — real daemon, real app-server, real turn | yes | `bun run test:live:bridge` | minutes + tokens |
| 2b | Reply outbox under a real held turn | yes | `bun run test:live:outbox` | ~1 min, no tokens |
| 2c | A real port-slot collision between two projects | yes | `bun run test:live:collision` | ~1 min, no tokens |
| 2d | `abg doctor --fix` against real drift | yes | `bun run test:live:doctor` | ~1 min, no tokens |
| 2e | Grok's leader lets a second client into a session it does not own | yes | `bun run test:live:grok` | ~1 min + tokens |
| 3 | Role files change real agent behavior | yes | `bun run test:live:roles` | minutes + tokens |
| 4 | Terminal-only — TUI rendering, keys, resume, restore | no | `docs/manual-test-plan.md` | manual |

Tiers 0 and 1 gate every change. Tier 2 and Tier 3 spend real model
tokens and take minutes, so they are deliberately outside `bun test
src`; run them before a release or when touching the transport or the
role pipeline.

Tiers 2b–2d are outside `bun test src` for a different reason: they
spawn real daemons on fixed ports and signal real processes, which is
not something a unit run should do on a developer's machine. They cost
no tokens — the app-server is a deterministic fake — so run them freely.

---

## Tier 0 — unit

`bun test src` over `src/unit-test/`. Pure logic and adapters driven
against fakes: message filtering and markers, project id and port
derivation, config and state-dir resolution, log rotation, daemon
lifecycle bookkeeping, the app-server protocol helpers, role file
seeding and rendering, the reply outbox, and the `abg log` parsing and
filtering layer.

Most recent run: **634 pass, 0 fail, 634 tests across 40 files (32s)**.

Two of these used to fail on WSL2 and were written off as
environmental:

- `DaemonLifecycle > isHealthy returns false for non-existent port`
- `DaemonClient > connect() rejects when server is not reachable`

WSL2 drops SYN to closed loopback ports rather than answering RST, so
both waited for a refusal that never arrived. That was not a test
problem. The probe measured **141 seconds** against a dead port, which
is 141 seconds of an unexplained hang in a real session and turns
`waitForReady`'s 40 retries into over an hour. Both probes now carry
their own deadline (1.5s for health/readiness, 5s for the control
connect), so the tests pass everywhere and the product no longer waits
on the kernel's SYN-retry budget. Any failure here is now a real one.

## Tier 1 — CLI integration

`src/e2e-cli.test.ts` and `src/unit-test/cli.test.ts`, included in the
same `bun test src` run. These spawn the CLI for real and assert on
behavior rather than internals: first-run setup, `abg init`, `abg
status`, `abg doctor`, `abg projects`, `abg roles`, multi-project
namespacing, and the argument rewriting each launch verb performs.

No daemon and no model calls — the daemon is faked where a launch would
otherwise start one. Two commands need more than a fake, and get it:

- `status-live.test.ts` stands up a real `/healthz` on an OS-assigned
  port and asserts what `abg status` reports for each combination of
  attached / detached / threadless / queued, plus the two ways the
  daemon can fail to answer. A fake would prove only that the printer
  works; the claim worth testing is that the command talks to the
  daemon at all, and to the port it actually bound.
- `doctor-fix.test.ts` runs `abg doctor --fix` against a real state dir
  and asserts both halves of the contract: the repairs it performs, and
  the ones it declines when the evidence goes stale between diagnosis
  and repair (a pid that came back to life, a lock that is young
  again). `--fix` deletes files and signals processes, so the declines
  matter more than the repairs.

## Tier 2 — full bridge end-to-end

`src/live-test/tier2-bridge-e2e.ts`, via `bun run test:live:bridge`.

The harness supplies the two human-shaped ends and stubs nothing else:

- **fake TUI** — a WebSocket client against the adapter's proxy port
  speaking the real handshake: `initialize` → `initialized` →
  `thread/start`. Request shapes come from `codex app-server
  generate-json-schema`, so they track the real protocol rather than a
  guess. It also watches `turn/started` and `turn/completed`
  notifications, which is how the harness knows when Codex is busy.
- **fake Claude** — an MCP stdio client against the real `src/bridge.ts`,
  calling the real `reply` and `get_messages` tools.

Everything between them is production code, including a real `codex
app-server` running a real model turn. The assertion is a nonce that
only reaches Claude if every link held.

Steps:

| Step | Assertion |
|---|---|
| T2.1 | daemon boots; app-server, proxy, and control ports all listening |
| T2.2 | TUI handshake completes and the adapter records a thread id |
| T2.3 | MCP handshake completes; `reply` and `get_messages` are exposed |
| T2.4 | the daemon's own "Claude is online" kickoff runs as a real turn |
| T2.5 | `reply` injects successfully — not rejected for a missing thread |
| T2.6 | Codex's `[REPLY]` reaches Claude with the nonce intact |
| T2.7 | both ports are released on shutdown |

Most recent run: **16 passed, 0 failed.** Codex's final message was
`[REPLY] TIER2-OK-4417`, delivered through `get_messages` after four
`[STATUS]`-shaped progress lines — so the filtered routing path is
exercised too, not just raw delivery.

Two things worth knowing before running it:

- The daemon injects a kickoff turn the moment Claude connects. T2.4
  waits that out on purpose; skipping the wait makes the real assertion
  fail against `turnInProgress` for the wrong reason.
- `bridge.ts` exits silently unless `AGENTBRIDGE_ACTIVE=1` is set. That
  gate stops a stray `claude` session from taking the daemon's single
  Claude slot; the harness sets it explicitly.

Ports default to 17801/17802/17803, well clear of the 14500+ range the
CLI derives per project, so a live session on the same machine cannot
collide. Override with `TIER2_APP_PORT`, `TIER2_PROXY_PORT`,
`TIER2_CONTROL_PORT`.

## Tiers 2b–2d — the failure edges, with a fake app-server

Tier 2 needs a real `codex app-server` because its claim is that a real
model turn survives the whole chain. The failure edges do not: what they
assert is daemon behavior, and a real model only makes them slow and
non-deterministic. `src/live-test/fake-codex-app-server.ts` speaks the
app-server protocol — `thread/start`, `turn/start`, `turn/started` and
`turn/completed` notifications, `item/agentMessage` — with turn duration
set by `FAKE_TURN_MS`, so a harness can hold a turn open for exactly as
long as it needs. `src/live-test/fake-codex-bin/codex` puts it on `PATH`
under the name the daemon spawns.

**2b — reply outbox** (`tier2-outbox-e2e.ts`). A reply sent while Codex
is mid-turn must be held and injected on completion, and the daemon must
say so rather than reporting success. Covers: the queue-on-refusal path,
the drain on `turn/completed`, FIFO order across several held replies,
the bounded-outbox eviction notice, expiry, and the "held reply was
lost" notice when the app-server dies with a reply still queued — each
asserted from Claude's side, where a dropped reply would look like
silence. Most recent run: **19 passed, 0 failed**.

**2c — port-slot collision** (`tier2-slot-collision.ts`). Project ids
hash into 1000 port slots, so two projects on one machine can derive the
same triple. Two daemons are started on one triple with different state
dirs; the second must refuse to bind rather than kill the first's
app-server, and must name the holder and the fix. The second half proves
the identity guard at the data level: a frontend declaring project B
against project A's daemon is closed with `CLOSE_CODE_PROJECT_MISMATCH`
and its reply never reaches A's Codex — with a live thread on A first,
so the check can actually fail. The last part finds two real directory
paths whose ids genuinely collide (by search, not hand-picked hex) and
asserts `abg doctor` names them. Most recent run: **18 passed, 0
failed**.

**2d — `abg doctor --fix`** (`tier2-doctor-fix.ts`). `--fix` deletes
files and signals processes, so the refusals matter more than the
repairs. Covers config drift, a stale pid file versus a live daemon, a
stale lock versus a fresh one, reaping an orphaned `bridge-server`
(a real detached process, via `setsid`), and a clean state dir where the
correct behavior is to do nothing. Most recent run: **23 passed, 0
failed**.

**2e — Grok leader attach** (`tier2e-grok-attach.ts`). The only tier
that tests something AgentBridge does not ship yet: whether Grok Build
can host the same trick the Codex adapter relies on — a second client
injecting a turn into a session a human already owns. `scaling-plan.md`
assumed it could not, and gated the whole Grok target on the assumption.
Two `grok agent --leader stdio` clients share a leader; B prompts A's
session with no `session/load` and both watch what arrives. The
load-bearing assertion is that **A still receives the stream for a turn
it did not start** — if only B saw it, attaching would blank the human's
screen. It then answers the question that decides how much machinery a
Grok adapter needs: B prompts again **while A's turn is still running**,
and the leader queues it to the turn boundary rather than erroring or
interleaving — so the outbox the Codex adapter carries has no Grok
equivalent to build. Also pins `x.ai/sessions/list`,
`x.ai/session/interjection` and `x.ai/interject` as absent from the ACP
surface, so no adapter gets written against methods that only exist in
the binary's strings or in a newer grok-build than the one installed.
Runs in an isolated `GROK_HOME` with `[cli] use_leader = true`, so the
user's own Grok config is never touched; skips cleanly when
`~/.grok/auth.json` is missing. Spends a small number of real xAI
tokens. Most recent run: **17 passed, 0 failed** (grok 0.2.114).
Background in `docs/scaling-plan.md` §4.1a.

## Tier 3 — role files change real agent behavior

`src/live-test/tier3-roles.sh`, via `bun run test:live:roles`.

Tier 0 already proves the render pipeline writes the right bytes. Tier 3
asks the question unit tests cannot: does an edited role file actually
change what a real agent does? Each step plants a distinctive token in
the role text and looks for it in the model's output, so a pass means
the whole chain held — role file → `abg roles apply` → the marked block
in `AGENTS.md` / `CLAUDE.md` → the agent process → observable behavior.

| Step | Assertion |
|---|---|
| T3.1 | seeding renders both `AGENTS.md` and `CLAUDE.md` |
| T3.2 | a rewritten role file reaches `AGENTS.md` |
| T3.3 | real `codex exec` obeys it |
| T3.4 | editing the role changes behavior; the old token is gone |
| T3.5 | same chain for `claude -p` and `CLAUDE.md` |
| T3.6 | an empty role file aborts with a named error and leaves the block untouched |
| T3.7 | deleting the role file falls back to the built-in default |

Most recent run: **14 passed, 0 failed** — `ZEBRA-7 / 2+2=4.`, then
`QUASAR-9 / 6.` with no trace of `ZEBRA-7`, then `ORYX-4 / 10.` from
Claude. T3.6 exited 1 with `Role file is empty` and did not touch
`AGENTS.md`; T3.7 fell back to a default still carrying `[REPLY]`.

T3.6's "left alone" assertion checks that the *previous* role text is
still in `AGENTS.md`, not that the abandoned `ZEBRA-7` is absent. The
absence version passed unconditionally — T3.4 had already replaced that
token — which is the failure mode worth watching for when adding steps
here: an assertion that cannot fail reads exactly like one that passed.

Uses `codex exec` and `claude -p`, both of which are genuinely headless.
No daemon is involved — this tier is about instruction plumbing, not
transport.

## Tier 4 — terminal-only

Everything that needs a real terminal, and therefore a human:

- the arrow-key agent picker on first run
- status line rendering and its lifecycle tags
- terminal state restoration after `abg codex` exits or crashes
- `codex resume` / `--last` flows driven from the TUI
- Codex TUI disconnect and reconnect behavior, including session restore
  after a silent reconnect
- visual confirmation of push vs pull delivery as the user experiences it

`docs/manual-test-plan.md` is the procedure. Tier 2 now covers the
*transport* underneath several of these, so a Tier 4 pass is about
presentation and terminal handling rather than message delivery.

## Running it

```bash
bun run check               # typecheck + Tier 0/1 + plugin sync + version check
bun test src                # Tier 0 + Tier 1 alone
bun run test:live:bridge    # Tier 2   (minutes, real tokens)
bun run test:live:outbox    # Tier 2b  (~1 min, no tokens)
bun run test:live:collision # Tier 2c  (~1 min, no tokens)
bun run test:live:doctor    # Tier 2d  (~1 min, no tokens)
bun run test:live:grok      # Tier 2e  (~1 min, real tokens, needs `grok login`)
bun run test:live:roles     # Tier 3   (minutes, real tokens)
```

Both live tiers take an optional lab directory as their first argument
and wipe it before starting; they default to a path under the system
temp directory.

## Known gaps

- Tier 2 covers the happy path and the missing-thread rejection; 2b
  covers a mid-turn app-server death. A Claude session swap and daemon
  crash recovery are still Tier 4 only. Both are reachable from the 2b
  harness (kill a process, assert the recovery path).
- No live tier asserts on token cost or latency, so a regression that
  makes the bridge slow but correct would pass.
- 2c forces the colliding port triple through env rather than by
  arranging two project roots that hash into it. The last part of the
  same file proves real ids do collide and that `abg doctor` names them,
  so what is untested is only the arithmetic in between — which is unit
  covered.
- Tier 4's list shrank by one: terminal save/restore now has unit
  coverage via the injected seam in `src/cli/terminal-restore.ts`. What
  a human still has to confirm is that the *real* escape sequences fix a
  *real* wrecked terminal — the tests prove the calls are made, in
  order, with the right fallbacks, not that the codes work.
