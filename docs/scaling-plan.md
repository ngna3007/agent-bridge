# AgentBridge — State of the App, CLI Surface, Review, and Scaling Plan

Status: draft for review
Date: 2026-07-27
Scope: full read of `src/` in the `agent-bridge/` repo at HEAD `b92a924`, branch
`master`, `package.json` version **0.6.8** (published as `@rowanng/agentbridge`).

> Correction (2026-07-27): an earlier revision of this line cited HEAD `67ebaa9` /
> v0.2.3. That is the **outer** `/home/ngocanh/AgentBridge` repo, not this one —
> `agent-bridge/` is a separate nested git repository. The source findings below
> were read from `agent-bridge/src/` and are unaffected; only the header metadata
> was wrong.

This document is in four parts:

1. **How it works today** — the real runtime, derived from the code, not from the older docs.
2. **CLI surface** — every command, flag, and env var that actually exists.
3. **Review findings** — what is solid, what is broken, with `file:line` evidence.
4. **The plan** — staged P0→P5, with the ACP/multi-agent research folded in.

---

## Part 1 — How AgentBridge works today

### 1.1 Process topology

Three processes, not two (the `CLAUDE.md` diagram is one process short of reality —
the `codex app-server` is spawned and owned by the daemon).

```
  ┌─ terminal A ──────────────┐        ┌─ terminal B ────────────────┐
  │ abg claude                │        │ abg codex                   │
  │  └─ claude (child)        │        │  └─ codex (child, TUI)      │
  │      └─ bridge.ts  ◀── MCP stdio   │      │                      │
  └──────────┬────────────────┘        └──────┼──────────────────────┘
             │ control WS  ws://127.0.0.1:<control>/ws
             ▼                                │ --remote ws://…:<proxy>
      ┌──────────────────────────────┐        │
      │ daemon.ts (background)       │◀───────┘
      │  • control server (Bun.serve)│
      │  • CodexAdapter              │
      │      ├─ proxy server :<proxy>│
      │      └─ app-server WS :<app> │
      └──────────────┬───────────────┘
                     │ spawn
                     ▼
        codex app-server --listen ws://127.0.0.1:<app>
```

- `src/bridge.ts` — foreground MCP server, loaded by Claude Code as a plugin channel.
  Dies with Claude Code. Self-exits immediately unless `AGENTBRIDGE_ACTIVE=1`
  (`bridge.ts:1`-ish gate), so a plain `claude` that happens to load the plugin
  never steals the daemon's single Claude slot.
- `src/daemon.ts` — long-lived. Owns bridge state, the Codex proxy, and the
  `codex app-server` child. Survives Claude Code restarts.
- `src/codex-adapter.ts` — the moat. 1649 lines of WebSocket proxy in front of
  the Codex app-server.

### 1.2 The Codex live-injection path (the thing nothing else does)

`abg codex` launches `codex --enable tui_app_server --remote ws://127.0.0.1:<proxy>`
(`src/cli/codex.ts:107`). The human's TUI therefore talks to **AgentBridge's proxy**,
not directly to the app-server. That gives the daemon a tap on both directions:

- **Codex → Claude**: the adapter watches notifications, buffers
  `item/agentMessage/delta` chunks, and on `item/completed` for an `agentMessage`
  emits a `BridgeMessage` (`codex-adapter.ts:1273-1286`).
- **Claude → Codex**: `injectMessage(text)` sends a `turn/start` JSON-RPC request
  with a **negative** id (`nextInjectionId = -1`, decrementing —
  `codex-adapter.ts:75`, `:239`) so bridge requests can never collide with
  proxy-rewritten TUI ids. The injected turn appears in the human's running TUI
  as a user message.

Everything else in that file exists to keep the proxy honest under real-world
churn. Notable machinery:

| Concern | Mechanism |
|---|---|
| Global id uniqueness | `nextProxyId = 100000`, `upstreamToClient` map, rewrite on the way out, restore on the way back (`:1026-1031`, `:1187-1199`) |
| TUI opens a 2nd socket for the resume picker | `secondaryConnections` — each picker gets its own dedicated app-server WS, primary untouched (`:749-787`) |
| Per-connection `initialize` scope | TUI `initialize` triggers a full app-server WS reconnect for a fresh session; raw TUI messages buffer and replay (`:967-984`, `:333-381`) |
| Upstream blip | `outageQueue` (max 64, 5s) buffers raw TUI bytes; overflow/timeout closes TUI with 1011 so codex-rs raises a *visible* fatal instead of hanging (`:449-501`) |
| Silent reconnect breaks session | Cache `initialize` + `initialized` raw payloads, replay them + `thread/resume` on unintentional reconnect (`:526-578`) |
| Approval requests survive TUI restarts | `pendingServerRequests` buffered, replayed on `thread/resume` matching thread id, dropped as orphans on `thread/start` (`:797-852`) |
| Rate-limit error crashes TUI | `patchResponse` fakes a success payload for `rateLimits` errors (`:1220-1244`) |
| Silent TUI exit diagnosis | Sniffs `thread/closed`, logs a correlatable DIAGNOSTIC line (`:1072-1078`); `cli/codex.ts:313-319` classifies child exits into `fatal_exit` / `not_initialized_after_reconnect` / `exit_0_empty_stderr` |

This is the hardest-won code in the repo and the reason AgentBridge is not
replaceable by "just run ACP".

### 1.3 Message routing and the marker protocol

`src/message-filter.ts` classifies every Codex `agentMessage` by leading marker
(`MARKER_REGEX`, `:~30`):

| Marker | Action | Where it lands |
|---|---|---|
| `[REPLY]` | forward | pushed as `notifications/claude/channel` |
| `[IMPORTANT]` | forward (legacy alias) | same |
| `[STATUS]` | buffer | `StatusBuffer`, flush at 3 msgs or 15s, summarized |
| `[FYI]` | drop | nowhere |
| *(untagged)* | queue | pull queue, drained by `get_messages` |

The daemon then tags each outbound with `deliveryHint: "push" | "queue"`
(`control-protocol.ts`), and `bridge.ts` routes: lifecycle ids → status line,
`"queue"` → `claude.enqueueForPull`, else → `claude.pushNotification`.

Claude→Codex is the mirror: `reply` tool → control WS `claude_to_codex` →
`daemon.ts:344-410` → `codex.injectMessage`. Contract text
(`BRIDGE_CONTRACT_REMINDER`) is appended once per Codex thread when
`AGENTBRIDGE_PIN_CONTRACT=once`, per-message when `always`, never when `off`
(the default) because `abg init` writes it into `AGENTS.md` instead.

### 1.4 The single-Claude-slot admission protocol

`daemon.ts:414-504`. Only one Claude frontend may hold the slot. On contest:

1. If a probe is already in flight → reject new with **4004** `PROBE_IN_PROGRESS`.
2. Otherwise ping the incumbent, wait `LIVENESS_PROBE_TIMEOUT_MS` (3000).
3. Incumbent answers → reject contestant with **4001** `REPLACED`.
4. Incumbent silent → evict it with **4002** `EVICTED_STALE`, accept contestant.
5. Re-check the slot after the await, because another contestant can race in.

This exists because a crashed peer may never produce a FIN, leaving
`readyState === OPEN` forever (issue #68). It is correct and well-tested.

### 1.5 Per-project namespacing (the thing the docs deny)

`src/project-id.ts`:

```ts
PROJECT_MARKER   = ".agentbridge"
BASE_PORT        = 14500
PORT_SLOT_COUNT  = 1000
PORTS_PER_PROJECT = 3

projectId = sha256(absoluteRootPath).slice(0, 8)
slot      = parseInt(projectId, 16) % 1000
ports     = { codexWs: 14500 + slot*3, codexProxy: +1, control: +2 }
```

`applyProjectEnv()` sets `AGENTBRIDGE_CONTROL_PORT`, `CODEX_WS_PORT`,
`CODEX_PROXY_PORT`, `AGENTBRIDGE_STATE_DIR`, `AGENTBRIDGE_PROJECT_ID` — and never
overwrites a value the user already set.

`src/runtime-namespace.ts` resolves precedence **env > project marker > default
(4500/4501/4502)**. `src/cli.ts:41` applies it *mutating* only for
`claude | codex | kill`; `status | doctor | projects` resolve read-only.

**Consequence: N projects × (1 Claude + 1 Codex) already works.** Each project
gets its own port triple, its own state dir, its own daemon, its own Claude slot.
`abg kill` scopes orphan reaping by the target's `AGENTBRIDGE_STATE_DIR`, so
killing project A cannot touch project B.

### 1.6 Lifecycle and state

State dir (`AGENTBRIDGE_STATE_DIR`, default `$XDG_STATE_HOME/agentbridge/` on
Linux, `~/Library/Application Support/AgentBridge/` on macOS, plus a per-project
nested subdir) holds:

- `daemon.pid`, `status.json`, `status.line`, `agentbridge.log`,
  `codex-wrapper.log`, `startup.lock`, `killed` sentinel, `tui.pid`.

Key behaviours:

- `killed` sentinel makes the daemon refuse to boot (`daemon.ts:869-872`), so a
  reconnect loop cannot resurrect what the user explicitly stopped. Only
  `abg claude` / `abg codex` clear it.
- Idle shutdown: no Claude *and* no TUI → shut down after
  `AGENTBRIDGE_IDLE_SHUTDOWN_MS` (`daemon.ts:581-604`).
- On shutdown, the daemon writes `BRIDGE_STOPPED_TAG` to `status.line` **before**
  tearing down the control server, because a dead bridge can't emit its own
  offline tag (`daemon.ts:834-839`).
- `bridge.ts` reconnects with exponential backoff `min(1000 * 2^n, 30_000)`, and
  has a disabled-state machine (`killed`, `evicted`, `rejected`,
  `probe_in_progress`, `auto_recovery_exhausted`) with a 5s recovery poller
  capped at 6 attempts.

---

## Part 2 — CLI surface (complete)

Binary names: `agentbridge` and `abg` (same entry, `src/cli.ts`).

### 2.1 Commands

| Command | Namespaced? | What it does |
|---|---|---|
| `abg init` | no | Per-project setup. Refuses at `$HOME`, `dirname($HOME)`, `/`, and refuses to nest under an ancestor `.agentbridge/`. Checks Bun / Claude (min `2.1.80`) / Codex. Writes `.agentbridge/config.json` with the derived port pair. Upserts the `<!-- AgentBridge:start/end -->` block into `CLAUDE.md` + `AGENTS.md`. Installs the plugin via `claude plugin install agentbridge@agentbridge`. |
| `abg dev` | no | Registers the local marketplace and installs the plugin from the working tree. Local-dev only. |
| `abg claude [args…]` | **yes** | Wires `~/.claude/settings.json` statusLine (idempotent), shows the first-run intro, then spawns `claude --dangerously-load-development-channels plugin:agentbridge@agentbridge <args>` with `AGENTBRIDGE_ACTIVE=1`. Owned flags (hard error if you pass them): `--channels`, `--dangerously-load-development-channels`. |
| `abg codex [args…]` | **yes** | `ensureRunning()` the daemon, wait for proxy `/healthz`, save `stty -g`, spawn `codex` with `--enable tui_app_server --remote <proxyUrl>` injected in the position clap expects, tee stderr into a 64KB ring buffer, restore the terminal on exit, classify the exit into `codex-wrapper.log`. Owned flags: `--remote`, `--enable tui_app_server`. |
| `abg kill [--all]` | **yes** | Writes the `killed` sentinel, kills the managed Codex TUI, stops the daemon, reaps orphan `bridge-server.js` processes scoped to this state dir. `--all` sweeps every state dir under the platform root. |
| `abg status` | read-only | Project id/root/ports, daemon state (`running` \| `stale` \| `starting` \| `stopped` \| `not running`), proxy/app-server URLs, last status-line tag (ANSI stripped), active env overrides. |
| `abg projects` | read-only | Enumerates every state dir under the platform root; prints ID / STATE / TAG / DIRECTORY sorted running → stale → stopped. Deliberately ignores `AGENTBRIDGE_STATE_DIR`. |
| `abg doctor` | read-only | Findings checklist with fixes: config-vs-derived port drift, stale `daemon.pid`, `startup.lock` older than 30s, `killed` sentinel, orphan bridge-servers, who is listening on each of the project's ports, legacy `AGENTBRIDGE_PIN_CONTRACT`. |
| `abg --help` / `-h` / *(bare)* | — | Help text. |
| `abg --version` / `-v` | — | Version from `package.json`. |

`abg codex` passes these first tokens straight through untouched (no TUI, no
bridge flags): `exec`/`e`, `review`, `login`, `logout`, `mcp`, `mcp-server`,
`plugin`, `remote-control`, `update`, `app-server`, `exec-server`, `app`,
`completion`, `sandbox`, `debug`, `apply`/`a`, `cloud`, `features`, `help`.
`resume` and `fork` get the bridge flags injected *after* the subcommand name
(clap defines them per-subcommand, not global).

### 2.2 MCP tools exposed to Claude

Exactly two (`src/claude-adapter.ts`):

- `reply({ chat_id?, text, require_reply? })` — send to Codex. `text` required.
- `get_messages({})` — drain the pull queue.

Push arrives as `notifications/claude/channel` with
`meta: { chat_id, message_id, user: "Codex", user_id: "codex", ts, source_type: "codex" }`.

### 2.3 Environment variables

| Var | Default | Effect |
|---|---|---|
| `AGENTBRIDGE_ACTIVE` | unset | **Gate.** `bridge.ts` exits immediately unless `=1`. Set by `abg claude`. |
| `AGENTBRIDGE_CONTROL_PORT` | 4502 / derived | Control WS port |
| `CODEX_WS_PORT` | 4500 / derived | Codex app-server port |
| `CODEX_PROXY_PORT` | 4501 / derived | Proxy port the TUI connects to |
| `AGENTBRIDGE_STATE_DIR` | platform | State dir override |
| `AGENTBRIDGE_PROJECT_ID` | derived | Informational |
| `AGENTBRIDGE_MODE` | `push` | `push` \| `pull` delivery |
| `AGENTBRIDGE_FILTER_MODE` | — | Marker-filter mode |
| ~~`AGENTBRIDGE_MAX_BUFFERED_MESSAGES`~~ | — | **Removed** (comms-lifecycle rework): the adapter's own buffer is gone. Mailbox capacity is now `MAILBOX_CAPACITY` in `src/daemon-constants.ts`, a compile-time constant with no env override. |
| `AGENTBRIDGE_IDLE_SHUTDOWN_MS` | — | Idle shutdown grace |
| `AGENTBRIDGE_ATTENTION_WINDOW_MS` | — | Status-buffer pause window after a Codex ping |
| `AGENTBRIDGE_PIN_CONTRACT` | `off` | `off` \| `once` \| `always` |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | 3000 | Incumbent probe timeout |
| `TUI_DISCONNECT_GRACE_MS` | 2500 | TUI reconnect grace |
| `CLAUDE_DISCONNECT_GRACE_MS` | 5000 | Grace before telling Codex "Claude went offline" |
| `RUST_LOG` / `RUST_BACKTRACE` | set by wrapper | Codex child diagnostics |

**Landmine:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (also
`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`) **silently kills the
push channel** while `get_messages` keeps working — upstream
anthropics/claude-code#36503. See `docs/channels-silent-block.md`.

---

## Part 3 — Review findings

### 3.1 What is genuinely good

- The Codex proxy's failure handling is better than most production networking
  code. Generation counters, id-space partitioning, raw-bytes-before-rewrite
  buffering, orphan-request thread attribution — all correct and all commented
  with *why*.
- Admission control (`attachClaude`) handles the hard case (no FIN from a dead
  peer) and re-validates state after every await.
- `abg doctor` / `abg status` / `abg projects` are a real diagnostic story, and
  they are read-only by construction.
- Per-project namespacing is done properly: derived, deterministic, env-override
  respecting, kill-scoped.
- 409/411 tests pass. Coverage is real, not decorative.

### 3.2 Bugs and gaps, ordered by severity

**F1 — Statusline is wired for exactly one project, forever.**
`src/settings-wire.ts`: `alreadyChained(command, _statusFilePath)` ignores its
path argument and returns `command.includes(GATE_MARKER)`. The gate marker is
`"$AGENTBRIDGE_ACTIVE" = "1"` — identical for every project. So the first
project to run `abg claude` writes `[ gate ] && cat /path/to/projectA/status.line`
into `~/.claude/settings.json`, and every later project sees "already wired" and
is skipped. Projects B..N silently get project A's status tags.
*Fix:* make the chained command read `$AGENTBRIDGE_STATE_DIR/status.line` at
runtime instead of baking an absolute path, and make `alreadyChained` actually
compare paths.

**F2 — Port-triple collision is silent and undetected.**
`computeProjectPorts` maps 2^32 project ids into 1000 slots. Birthday collision
at ~38 projects is ~50%. Nothing detects it: `startControlServer()`
(`daemon.ts:277-320`) is a bare `Bun.serve(...)` with **no try/catch and no
`EADDRINUSE` branch**, and `process.on("uncaughtException")` only logs
(`daemon.ts:853-855`). Two colliding projects produce a daemon that appears to
start and then does nothing. `CodexAdapter.checkPorts()` guards the codex ports
but not the control port, and it *kills* anything that looks like a stale
`codex app-server` — which, on a collision, is project B's live app-server.
*Fix:* replace derivation-as-truth with a **lease file** — derive a *preferred*
port, probe it, walk forward on conflict, record the actual triple in the state
dir, and have `abg status`/`doctor` read the lease rather than re-derive.

**F3 — Docs contradict the code.**
`CLAUDE.md` still says "Ports are fixed: 4500/4501/4502. One AgentBridge instance
per machine (multi-project support is post-v1)", and `README.md:353` repeats it.
Multi-project shipped. Users read this and don't try it.
*Fix:* one-line docs edit; zero code risk.

**F4 — Two deterministic test failures on WSL2.**
```
DaemonLifecycle > isHealthy returns false for non-existent port   timed out after 5000ms
DaemonClient   > connect() rejects when server is not reachable   timed out after 5000ms (120s wall)
```
Cause: WSL2 drops SYN to a closed loopback port rather than returning
`ECONNREFUSED`, so the connect never settles. Not an AgentBridge logic bug, but
it means `bun run check` is red on the primary dev machine.
*Fix:* bound the connect with an explicit timeout in `daemon-lifecycle.ts` and
`daemon-client.ts` — which is the correct production behaviour anyway.

**F5 — `src/audit-log.ts` does not exist** but is imported/referenced from
`status-line-writer.ts:13`. Dead reference; also means there is no audit trail to
build multi-agent debugging on later.

**F6 — `config.json` port drift is real in-tree.**
`agent-bridge/.agentbridge/config.json` carries `4500/4501`; derived is
`16006/16007`. Harmless at runtime (env wins) but `abg doctor` warns forever.

### 3.3 Structural blockers for N agents in one project

Multi-*project* works. Multi-*agent within a project* does not, and these are
the reasons, not opinions:

| # | Blocker | Evidence |
|---|---|---|
| B1 | Identity is a closed two-member union | `src/types.ts:3` — `type MessageSource = "claude" \| "codex"` |
| B2 | Protocol has no addressing | `src/control-protocol.ts:13-38` — no `from`, `to`, `roomId`, `traceId`, `idempotencyKey`. Only `requireReply`, `requestId`, `deliveryHint`. |
| B3 | Exactly one Claude slot | `daemon.ts:63` `let attachedClaude` — a single socket, plus a whole eviction protocol built to enforce singularity |
| B4 | Exactly one Codex backend | `PORTS_PER_PROJECT = 3` (`project-id.ts:51`); `CodexAdapter` is instantiated once in `daemon.ts` |
| B5 | Peer identity hardcoded in prompts | `claude-adapter.ts:30-112` (`CLAUDE_INSTRUCTIONS`) and `message-filter.ts:63-110` (`BRIDGE_CONTRACT_REMINDER`) both name Codex and fix the Executor/Advisor split |
| B6 | Source is forged, not asserted | `message-filter.ts:167-172` — `StatusBuffer` stamps `source: "codex"` on its own summary; `claude-adapter.ts` fabricates `sessionId = \`codex_${Date.now()}\`` as the chat id |
| B7 | Everything is module-level singleton state | `daemon.ts:63-106` — `attachedClaude`, `codexBootstrapped`, `replyRequired`, `lastPinnedContractThreadId`, `challengeInProgress`, `bufferedMessages`, `inAttentionWindow` |
| B8 | No durability | Messages live in a 100-entry in-memory array; daemon restart loses everything |

`docs/v2-architecture.md` (748 lines) already designs the answer — registry,
rooms, full envelope with `roomId`/`messageId`/`traceId`/`idempotencyKey`/
`from{agentId,sessionId,agentType,name}`/`to{agentIds}`/`mentions`/`deliveryMode`/
`ack`, policy layer, SQLite. **None of it is implemented.** The gap between the
v2 doc and `src/` is the single biggest risk to this project: the design is done,
the migration is not, and every week of new features on the current singletons
makes the migration more expensive.

### 3.4 Token economics (why "just add more agents" is wrong)

Naive broadcast is O(N²) in tokens: each of N agents sends to N-1 others, and
every message costs input tokens on receipt *and* pollutes context for the rest
of the session. The current design already fights this (marker protocol, pull
queue by default, contract pinned once per thread instead of per message,
ultra-terse cross-agent style). Any N-agent design must keep that discipline as
a **first-class constraint**, not an afterthought: default to addressed
(unicast) delivery, make broadcast explicit and rate-limited, and keep the
buffer/summarize path for status chatter.

---

## Part 4 — The plan

### 4.0 Design principles

1. **Live injection is the moat.** ACP, MCP, and every registry give you
   *spawn-and-drive*. Only vendor-specific attach surfaces give you *inject into
   the session a human is already using*. Protect and generalize that.
2. **Migrate the envelope before adding agents.** Every feature added on top of
   `MessageSource = "claude" | "codex"` is a feature that must be rewritten.
3. **No silent failure.** Every collision, drop, and downgrade must produce a
   visible signal — the F2 port collision and the `CLAUDE_CODE_DISABLE_
   NONESSENTIAL_TRAFFIC` push-drop are both invisible today.
4. **Ship per stage.** Each P below is independently valuable and independently
   releasable.

### P0 — Papercuts (days, no architecture risk)

- **F3**: fix `CLAUDE.md` + `README.md:353` multi-project claims.
- **F4**: bounded connect timeouts in `daemon-lifecycle.ts` / `daemon-client.ts`
  → green `bun run check` on WSL2.
- **F1**: statusline reads `$AGENTBRIDGE_STATE_DIR/status.line` at runtime;
  `alreadyChained` compares the actual path.
- **F5**: create `src/audit-log.ts` (append-only JSONL in the state dir) or
  delete the reference. Prefer creating it — P2 needs it.
- **F6**: regenerate `.agentbridge/config.json`, or stop writing ports into it
  at all (derivation + lease is the source of truth).
- **Silent-push-drop sentinel**: at bridge startup, detect
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and friends; if set, log a loud
  warning and auto-fall back to `AGENTBRIDGE_MODE=pull` instead of silently
  losing every push.

**Exit criteria:** `bun run check` green; two projects side-by-side each show
their own status tag.

### P1 — Port leases (1 week)

Replace "derived port is truth" with "derived port is a hint".

- New `src/port-lease.ts`: `acquire(preferredBase, count) → {ports, release()}`.
  Probe-then-bind with forward walk; write `ports.lease` (JSON: pid, ports,
  acquiredAt) into the state dir; stale-lease reclaim by pid liveness.
- `daemon.ts:startControlServer` wraps `Bun.serve` in try/catch, handles
  `EADDRINUSE` explicitly, and exits with a diagnosable message rather than an
  uncaught exception.
- `CodexAdapter.checkPorts()` refuses to kill a `codex app-server` that belongs
  to a *different* state dir (check the process env, same technique
  `findOrphanBridgeServers` already uses).
- `abg status` / `abg doctor` read the lease file instead of re-deriving.
- Bump `PORT_SLOT_COUNT` is *not* the fix — leases are.

**Exit criteria:** two projects that hash to the same slot both start, both work,
and `abg projects` shows both with distinct ports.

### P2 — Identity and envelope (2–3 weeks) — *the load-bearing stage*

This is the migration `docs/v2-architecture.md` describes. Do it before anything
else in Part 4, because everything after depends on it.

- `src/types.ts`: `MessageSource` becomes `AgentId` (opaque string) plus an
  `AgentDescriptor { agentId, agentType, sessionId, name, capabilities }`.
  `agentType` is an open union: `"claude" | "codex" | "grok" | "opencode" | string`.
- `src/control-protocol.ts`: every message carries an envelope —
  `{ messageId, traceId, idempotencyKey, from: AgentDescriptor, to: AgentId[] | "broadcast", roomId?, deliveryMode, mentions?, ts }`.
  Keep the current message *types*; add the envelope around them. Version the
  protocol (`protocolVersion` in the connect handshake) so old bridges get a
  clear rejection instead of a parse failure.
- Loop prevention moves from "never send back to `source`" to "never send back to
  any `AgentId` in the `from` chain".
- `StatusBuffer` and `claude-adapter` stop forging identity (B6): summaries are
  attributed to the bridge (`agentId: "agentbridge"`, `agentType: "system"`), and
  `chat_id` becomes the real room/thread id rather than `codex_${Date.now()}`.
- Audit log (from P0) records every envelope. This is what makes N-agent
  debugging tractable.
- Prompts (B5) get templated: `CLAUDE_INSTRUCTIONS` and `BRIDGE_CONTRACT_REMINDER`
  take the peer roster as input instead of hardcoding "Codex".

**Exit criteria:** the wire format supports N agents even though the daemon still
runs 1+1. All existing tests pass against the new envelope. Old-protocol clients
get an explicit version-mismatch close code.

### P3 — Registry and multi-slot daemon (2–3 weeks)

- `attachedClaude: ServerWebSocket | null` becomes
  `agents: Map<AgentId, AgentConnection>`. The 4001/4002/4004 admission protocol
  is retained but re-scoped: it now enforces *one connection per agentId*, not
  *one Claude per machine*.
- Extract the module-level singletons (B7) into a `Session` / `BridgeState`
  object so multiple backends can coexist in one daemon.
- `CodexAdapter` becomes one instance per backend, keyed by agentId, each with
  its own port lease (P1 makes this possible).
- New CLI: `abg agents` (list connected agents in this project),
  `abg attach <agentType>` as the generic form of `abg codex`.

**Exit criteria:** one project, one daemon, 1 Claude + 2 Codex sessions, messages
addressed by agentId, no cross-talk.

### P4 — Adapter contract + ACP tier (3–4 weeks)

Research verdict (see §4.1) says the right shape is **two tiers**:

```ts
interface AgentAdapter {
  readonly agentType: string;
  start(): Promise<void>;
  inject(msg: OutboundMessage): Promise<InjectResult>;
  on(event: "message" | "turnStarted" | "turnCompleted" | "ready", cb): void;
  stop(): void;
}
```

- **Tier 1 — one generic ACP client adapter.** Speaks ACP JSON-RPC over stdio;
  spawn command comes from the machine-readable ACP registry
  (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
  38 agents as of 2026-07). This buys ~38 agents for the cost of one adapter.
  Semantics: *AgentBridge owns the session* (spawn-and-drive), not live injection.
- **Tier 2 — per-vendor attach strategies** for "the human already has a TUI
  open". No standard covers this in 2026. Only three targets are worth building:
  - **Codex** — `tui_app_server` + `--remote` proxy. Already built; refactor it
    behind the interface without changing behaviour.
  - **Grok Build** — leader socket `~/.grok/leader.sock`. Verified end-to-end
    on 2026-07-30 against grok 0.2.114 (§4.1a): a second ACP client
    `session/prompt`s straight into the session a live TUI owns, the turn lands
    in the human's transcript, and both clients get the full update stream. No
    proxy, no MITM — the cheapest of the three Tier-2 targets. **Precondition:**
    the human's TUI must run with `[cli] use_leader = true`; the default TUI
    embeds its agent and is unreachable.
  - **opencode** — `--port 4096`, `POST /tui/append-prompt` + `POST /tui/submit-prompt`,
    replies via `GET /event` SSE. Documented; this is how their IDE plugins work.

**Exit criteria:** Codex works through the interface with zero behaviour change;
one Tier-1 ACP agent works end-to-end; one Tier-2 target (Grok or opencode) works
end-to-end.

### P5 — Rooms, policy, durability (open-ended)

Only after P2–P4. Rooms, `role:<name>` addressing, requires-human / escalate,
async dispatch/collect, edit locks, presence — i.e. the rest of
`docs/v2-architecture.md` and `docs/python-port-plan.md`. Durability (SQLite or
append-only log + snapshot) belongs here: it is what makes daemon restarts
non-destructive and makes replay-based debugging possible.

---

### 4.1 Research findings that shaped this plan

Sourced from a dedicated research pass (2026-07-27). Full detail in the
research transcript; the load-bearing conclusions:

**Grok CLI — yes, and it is the *easiest* of the three targets.**
Official xAI CLI is **Grok Build** (`grok`), `@xai-official/grok` v0.2.112,
Apache-2.0 Rust source at `github.com/xai-org/grok-build`, install
`curl -fsSL https://x.ai/cli/install.sh | bash`, docs `docs.x.ai/build/overview`.
It ships three external-control surfaces, all ACP:

```
grok agent --always-approve stdio                                        # ACP over stdio
grok agent --always-approve serve --bind 127.0.0.1:2419 --secret <tok>   # ACP over WebSocket
grok agent leader                                                        # shared leader process
```

`serve` is a near-exact analogue of Codex's `tui_app_server` — local WS,
token-auth (`GROK_AGENT_SECRET`), state survives client reconnects, and it even
has its own `--remote <url>` proxy flag. The **leader socket**
(`~/.grok/leader.sock`, overridable with the global `--leader-socket`) is
explicitly a single-leader-per-machine ACP router for multiple clients
(TUI / IDE extensions / headless) — architecturally what AgentBridge wants.

**The stream-stealing risk was refuted by experiment — see §4.1a.** The leader
fans out. The remaining constraint is not protocol, it is configuration: the
interactive TUI only joins a leader when told to.

### 4.1a Grok leader experiment (2026-07-30, grok 0.2.114, WSL2)

> **Superseded as a design, kept as evidence — see §4.1c.** What shipped is a
> man-in-the-middle proxy, not the side-car client this section proposes. The
> measurements below still hold; the design conclusions drawn from them do not.

Run because the paragraph above gated the whole Grok target on an untested
claim. Two experiments; scripts in the session scratchpad, worth promoting to
`src/live-test/` before any Grok code lands.

**Experiment 1 — does a second client steal the stream?** Two
`grok agent --always-approve --leader stdio` clients on one leader. Client A
does `initialize` + `session/new`; client B does `initialize` only, then
`session/prompt`s into A's `sessionId` uninvited — no `session/load`.

- B's prompt returned `stopReason: "end_turn"`. Uninvited injection is accepted.
- **A saw 35 chunks, B saw 35 chunks**, both containing the injected nonce. The
  leader fans `session/update` out to every connected client; it does not route
  to a single owner.
- A then prompted its own session and got 29 further chunks, which B also
  received. Ownership was never transferred, so nothing was stolen.

`session/load` was never needed and never called.

**Experiment 2 — is a human's TUI reachable this way?** A real TUI under a pty
with `[cli] use_leader = true`, prompted normally, then injected into from a
separate ACP client.

- The TUI **spawned a leader**: `grok leader list` → `PID … (Reachable)`, process
  `grok agent leader --no-exit-on-disconnect --relay-on-demand`. Leader mode is
  resolved by the TUI, not only by `grok agent`.
- Injection by `session/prompt` on the TUI's `sessionId` returned `end_turn`, and
  the TUI ran a visible Waiting→Responding cycle for the injected turn.
- **The injected turn is in the human's own transcript.**
  `sessions/<cwd>/<id>/chat_history.jsonl` shows
  `user: <user_query>Reply with exactly this…</user_query>` followed by the
  assistant's answer — same session, same history, indistinguishable from typed
  input.

**Constraints this leaves:**

1. **Opt-in leader.** Default config has no `use_leader`; a default TUI embeds its
   agent and no leader socket exists (confirmed against a TUI running 1h35m —
   `grok leader list` → "No leader candidates found"). AgentBridge must set
   `[cli] use_leader = true` in `~/.grok/config.toml` during setup, and `abg
   doctor` must check it. It is user-global config, so ask before writing.
2. **Discovery is a file, not a method.** `x.ai/sessions/list`,
   `x.ai/session/list` and `x.ai/session/interjection` all answer `-32601 Method
   not found` on the agent's ACP surface, despite appearing in the binary — they
   are not part of the client-facing protocol. `$GROK_HOME/active_sessions.json`
   holds `{session_id, pid, cwd}` per live session and is what the attach path
   should read. `x.ai/session/interjection` in particular is not a method an
   adapter may call: the only place it appears is
   `xai-grok-pager/src/app/acp_handler/` — it travels **agent → client**, as a
   notification the TUI renders, which is why calling it inbound is a method-not-
   found.
3. **Unix socket path limit.** The leader socket is `$GROK_HOME/leader.sock`
   under `SUN_LEN` (~108 chars). A long `GROK_HOME` fails with
   `path must be shorter than SUN_LEN` and then `Timeout waiting for IPC socket
   to be created` — hit during this experiment. Any temp-dir test harness must
   use a short path.
4. **Turn-busy is handled by the leader, not by us** (measured 2026-07-31, same
   build). A owns the session and starts a 25-item turn; 3.6 s in, B — still
   uninvited — `session/prompt`s the same `sessionId`. The leader **serialises**:

   | event | at |
   |---|---|
   | B's prompt sent | +3.6 s |
   | A's long turn returns `end_turn` | +6.9 s |
   | B's injected text appears in A's stream | +6.9 s |
   | B's prompt returns `end_turn` | +9.1 s |

   No busy error, no interleaving, no lost turn — the second prompt simply waits
   for the turn boundary and then runs, and both clients see both turns. **This
   is the outbox, implemented server-side.** A Grok adapter does not need the
   queueing machinery `src/codex-adapter.ts` carries; it needs the opposite —
   a `session/prompt` call with a timeout long enough to survive an arbitrarily
   long turn in front of it, because the request stays pending the whole time.

**On mid-turn interjection:** the grok-build source at HEAD registers
`x.ai/interject` (`xai-grok-shell/src/extensions/interject.rs`) — it queues text
into the session's pending-interjection buffer, drained "at the next safe point
in `process_conversation_turn`", and returns `"queued"`. That is *true* mid-turn
steering, stronger than the queue-at-boundary above. It does not exist in
0.2.114: the string is absent from the binary and the call returns `-32601`.
Treat it as a capability to feature-detect later, not one to build on now.

A cheap outbound-only option still exists regardless: Grok `[hooks]` firing on
message events with `$GROK_MESSAGE` / `$GROK_SESSION_ID`.

### 4.1b Grok already loads our MCP server (2026-07-31, grok 0.2.114)

Found while probing Q8, and it moves the Grok design more than §4.1a does.
Asked whether it had `reply` / `get_messages`, Grok in this repo answered that
**"the AgentBridge MCP server failed to connect (handshake / broken pipe)"** —
it was not reasoning about our tools from the instruction files, it had *tried
to launch them*. `grok inspect` shows why: Grok reads Claude Code's plugin
registry, and lists `agentbridge (user, enabled) — hooks, 1 MCPs` among the
plugins it loads. `grok mcp list` says "No MCP servers configured", so this
arrives entirely through the Claude plugin surface, not Grok's own config.

The handshake failed for a reason we put there: `bridge.ts` exits silently
unless `AGENTBRIDGE_ACTIVE=1`, the gate that stops a stray `claude` from taking
the daemon's Claude slot. Grok is launched outside `abg`, so it never inherits
it. Re-run with the variable set, in a scratch project:

- Grok's tool search resolved **`agentbridge__get_messages`** — the MCP
  handshake completed and our tools are addressable by name.
- The daemon log shows the full chain: `ClaudeAdapter created` →
  `MCP server connected (mode: push)` → `ensuring AgentBridge daemon` →
  **`Claude frontend attached (#2)`**.

So the outbound half of a Grok integration — Grok sending into the bus — needs
no adapter at all. It needs an env var and an identity.

**The blocker is the identity, not the transport.** Grok attaches *as Claude*:
`attachedClaude` in `src/daemon.ts` is one slot, and a second frontend is
rejected with `another Claude session is already connected` unless the incumbent
fails a liveness probe (asserted in `src/unit-test/daemon-client.test.ts`). Run
Claude and Grok together today and they fight over that slot. A third agent on
the MCP path therefore needs the daemon to key frontends by agent identity
rather than by the single Claude slot — a real change to `daemon.ts` and
`control-protocol.ts`, and the thing to design before writing any Grok code.

**Which leaves two paths, and they are complementary rather than rival:**

| Direction | Mechanism | State |
|---|---|---|
| Grok → bus | our own MCP server, via the Claude plugin registry | works today with `AGENTBRIDGE_ACTIVE=1`; blocked only by the single Claude slot |
| bus → Grok | leader socket `session/prompt` (§4.1a) | verified, queues at the turn boundary, needs `[cli] use_leader = true` |

MCP cannot carry the inbound direction — it has no server-push wake-up (see the
standards note below), and the Channels notification Claude receives is
Claude-specific. So the leader work in §4.1a is not made redundant by this
finding; it becomes the inbound half of a two-mechanism design where the
outbound half is nearly free.

**Standards landscape:**

- **ACP has won** for terminal coding agents. SDKs in TS/Rust/Python/Go/Kotlin;
  clients Zed, Neovim, Emacs, marimo, VS Code extension; JetBrains pending.
  Machine-readable registry with verbatim launch commands. **But**: baseline ACP
  is one-client-owns-one-subprocess over stdio. It cannot attach to a live
  human-driven session. It complements the moat; it does not replace it.
- **Microsoft AHP** (`github.com/microsoft/agent-host-protocol`) layers
  multi-client synchronized sessions on ACP — `listSessions` to enumerate and
  subscribe to *another client's* sessions, `chat/turnStarted`, `chat/delta`.
  This is literally AgentBridge's problem, standardized. Ships in VS Code 1.129.
  Explicitly "not yet stabilized"; the `ahpx` client is not on npm.
  **Watch it, design so you could adopt it, do not depend on it.**
- **MCP sampling is deprecated** (SEP-2577, revision `2026-07-28`, removal on/after
  2027-07-28). Elicitation survives but only fires inside a host-initiated tool
  call. **MCP has no server-push wake-up primitive.** Never build the bridge on
  either. The Claude side must stay on Channels.
- **Claude Channels is now formally documented**
  (`code.claude.com/docs/en/channels`): an MCP server declaring
  `capabilities.experimental['claude/channel']` pushes `notifications/claude/channel`
  into a live session. Worth auditing our plugin against the documented contract
  — we shipped against the pre-doc behaviour.
- **A2A is irrelevant** here (enterprise server-side; zero CLI adoption).
- **Name collision:** IBM/AGNTCY's "Agent Communication Protocol" is also ACP and
  is unrelated. Several 2026 comparison articles conflate the two.

**Other CLIs, ranked for live injection into a human's running session:**

| CLI | Reality |
|---|---|
| opencode | Strongest — TUI *is* a client of a server. `--port`, `/tui/append-prompt`, `/tui/submit-prompt`, `GET /event` SSE, OpenAPI at `/doc`, `OPENCODE_SERVER_PASSWORD` |
| Grok Build | **Verified** — inbound: inject into a live TUI's session over the leader socket, fan-out to every client, queued at the turn boundary (§4.1a); needs `[cli] use_leader = true`. Outbound: Grok already loads our MCP server via the Claude plugin registry and needs only `AGENTBRIDGE_ACTIVE=1` plus a daemon frontend slot of its own (§4.1b) |
| Codex | `tui_app_server` — what we already have |
| Qwen Code | `qwen serve` exists, but TUI co-hosting is "Stage 1.5", unshipped |
| Copilot CLI | `copilot --acp --port <N>` — real listener, but spawn-your-own, not attach; auth undocumented |
| Amp | True mid-turn steering via Plugin API (`appendUserMessage({…},{steer:true})`, `amp.activeThread`) — but requires shipping a long-lived plugin process |
| Aider | `--watch-files` + `AI!` comments only. Write-only, no reply stream. No MCP. No 2026 release |
| Gemini CLI | stdio ACP only — **and EOL** (individual tiers ended 2026-06-18; successor is Antigravity CLI `agy`) |

**Unverified / caveats to carry forward:** Codex's public `docs/app-server.md`
404s — our working implementation is the best available evidence for that
protocol. Amp data is mirror-sourced (ampcode.com unreachable). The official MCP
client-capability matrix page was deleted 2026-05-27, so third-party
sampling/elicitation claims may have drifted. Grok pricing tiers unconfirmed.

---

### 4.1c Grok ships as a proxy, not a side-car (2026-08-05, grok 0.2.118)

§4.1a and §4.1b together described a side-car: a second ACP client on the
leader for inbound, and Grok's inherited MCP tools for outbound. That is not
what shipped. Two things changed the call.

**Measurement.** `use_leader` is gone — leader mode is the default in 0.2.118,
and a leader was running on this machine with no config entry at all, so the
"needs `[cli] use_leader = true`" precondition repeated throughout Part 4 is
dead. The leader socket is also not newline-delimited JSON-RPC: frames are
`[u32 big-endian length][JSON]`, and ACP travels inside them as
`{"type":"acp","payload":"<ACP JSON-RPC, JSON-encoded as a string>"}` — two
parses to read one message. See `src/grok-leader-protocol.ts`.

**Design.** `grok --leader-socket <path>` is honored by real clients, which
makes a man-in-the-middle possible: the daemon owns a socket, `abg grok`
launches the TUI against it, and every frame is forwarded to the real
`~/.grok/leader.sock` untouched. That is the same topology the Codex side
already has, and it is what buys the same behavior — the daemon sees the
human's `session/prompt` *and* the response that closes it, so a turn boundary
is observed rather than inferred from an idle timer, and there is no cwd
matching or `session/list` discovery to get wrong.

The MITM leg only observes. Injection goes out over a second, dedicated leader
connection, which avoids rewriting JSON-RPC ids on a stream carrying a live
human session. The injector ignores `session/update`, or every update the
leader fans to both legs would be counted twice.

**Consequence for §4.1b:** Grok no longer attaches as an MCP frontend at all.
`FrontendAgent` is `"claude"` alone again, `abg grok` sets no
`AGENTBRIDGE_ACTIVE` / `AGENTBRIDGE_AGENT`, and it clears any it inherited —
a Grok launched from a terminal under `abg claude` would otherwise have its
MCP child evict the real Claude from its slot.

---

## Appendix — sequencing summary

| Stage | Duration | Unblocks | Risk |
|---|---|---|---|
| P0 Papercuts | days | trust in `bun run check`, honest docs | none |
| P1 Port leases | ~1 wk | >38 projects, collision safety | low |
| P2 Identity + envelope | 2–3 wk | **everything below** | medium — protocol break, needs versioning |
| P3 Registry + multi-slot | 2–3 wk | N agents per project | medium |
| P4 Adapter contract + ACP | 3–4 wk | ~38 agents (Tier 1) + Grok/opencode (Tier 2) | medium |
| P5 Rooms/policy/durability | open | v2 as designed | high — do last |

Do **not** reorder P2 later. Every stage after it assumes the envelope.
