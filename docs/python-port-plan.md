# Python-port plan — migrating ngna3007/AgentBridge (Python) features into this TypeScript fork

> Status: planning, not yet implemented. Captured after reading `src/bridge.ts`, `src/daemon.ts`, `src/codex-adapter.ts`, `src/claude-adapter.ts`, `src/control-protocol.ts`, `src/app-server-protocol.ts`, `docs/v1-roadmap.md`, `docs/v2-architecture.md`, and the parent Python prototype.

## Why this fork exists

`ngna3007/AgentBridge` (Python) and `quilin-ai/agent-bridge` (TypeScript) independently arrived at the same name + the same goal. After auditing both:

- The TypeScript project owns the **live single-TUI streaming UX** (codex injection via `--enable tui_app_server --remote`). This is the hardest piece and the Python prototype could not do it.
- The Python project shipped pieces this fork's `docs/v2-architecture.md` explicitly calls out as future work: N-agent generalization, role-based routing, policy/escalation rules, async dispatch/collect, terse wire codec, audit log + transcript, edit locks, presence heartbeats.

This fork merges the two — keep this project's live-TUI strength, port the Python project's v2-foundation work on top.

## Architecture-as-read (invariants we must NOT break)

### Three-process layout

```
Claude Code TUI ── MCP stdio ──▶ bridge.ts (foreground)
                                     │ control WS :4502
                                     ▼
                                 daemon.ts (persistent background)
                                     │ proxy WS :4501
                                     ▼
                                 codex app-server :4500
```

- **`bridge.ts`** — MCP server exposed to Claude Code. ~460 LOC. Exits with Claude Code.
- **`daemon.ts`** — background router + codex lifecycle. ~811 LOC. Survives Claude restarts; bridge reconnects with exp backoff.
- **`codex-adapter.ts`** — proxy between Codex TUI and the spawned `codex app-server`. ~1648 LOC. The complexity hot-spot.

### Hard invariants

1. **`source` field for loop prevention.** Every `BridgeMessage` carries `source: "claude" | "codex"`. The bridge **never** forwards a message back to its origin.
2. **Negative ids reserved for bridge-injected turns.** `codex-adapter.ts:75` — `nextInjectionId = -1` (decrements). TUI uses positive ids. Do not collide.
3. **Single-Claude slot per daemon, challenge-on-contest.** When a contestant arrives while the slot is occupied, fire a liveness probe (`probeLivenessImpl`); if no pong within `LIVENESS_PROBE_TIMEOUT_MS` (default 3s) the incumbent is evicted (close code `4002 CLOSE_CODE_EVICTED_STALE`). Issue #68.
4. **`turnInProgress` blocks `injectMessage`.** Don't inject mid-turn — codex rejects and we surface an error to Claude.
5. **`replyRequired` semantics.** When the `reply` tool is called with `require_reply: true`, daemon force-forwards all codex messages for that turn (bypasses STATUS buffering) and emits a warning if codex completes without `agentMessage`.
6. **STATUS/IMPORTANT/FYI marker contract** (`src/message-filter.ts`). Codex-side prompt teaches markers; daemon classifies and buffers. Don't break this — it's load-bearing for noise reduction.
7. **State directory.** `~/Library/Application Support/AgentBridge/` (mac) or `$XDG_STATE_HOME/agentbridge/` (linux). Holds `daemon.pid`, `status.json`, `agentbridge.log`, `killed` sentinel, `startup.lock`. Don't move files.
8. **Killed sentinel.** `abg kill` writes a sentinel. `bridge.ts` refuses to auto-reconnect until cleared. Honor this.
9. **Fixed ports (v1 limit).** `CODEX_WS_PORT=4500`, `CODEX_PROXY_PORT=4501`, `AGENTBRIDGE_CONTROL_PORT=4502`. One instance per machine. Multi-instance is v2 scope.
10. **Plugin-sync rule.** Built `dist/`/`plugins/agentbridge/server/*.js` is what Claude Code loads — NOT raw `src/`. Always `bun run build:plugin` after src changes. CI's `verify:plugin-sync` enforces this.
11. **Cross-review process.** Claude-written code reviewed by Codex; codex-written by Claude. Squash merge. Bilingual (zh + en) commits & release notes.
12. **`bun run check` is the pre-commit gate.** Typecheck + tests + plugin sync + plugin versions. Don't push without it.

### Where the v2-architecture pieces will land

Per `docs/v2-architecture.md`:
- **Daemon becomes pure router** (today it owns routing + codex lifecycle + TUI mgmt). Codex lifecycle moves into a `codex-adapter` *process*, not just a module.
- **Agent Registry** — tracks agentId, agentType, declared capabilities, current connection.
- **Room Manager** — communication scope; agent ∈ many rooms; default room per agent.
- **Adapter pattern** — `claude-adapter`, `codex-adapter`, future `gemini-adapter` all speak a shared control protocol.
- **Policy layer** — pluggable turn-coord, semantic routing, auto-pair.

## Python → TypeScript feature mapping

Mapping each Python phase (already shipped in `ngna3007/AgentBridge`) to a target in this fork:

| Python feature | Phase | Fork landing | Maps to v2 piece |
|---|---|---|---|
| `bus.json` + N-agent identity, `agents add/list/remove` | A | Agent Registry in daemon + handshake declaration | v2 Core |
| async `dispatch --tag` + `collect --tag [--wait]` | B | New MCP tools on bridge: `dispatch(to, tag, prompt)`, `collect(tag, waitMs)` backed by daemon-side message log | v2 — async pattern |
| Terse codec (short keys, performatives) | C | Optional `format: "terse"` arg on `get_messages` + on push notifications | New (cross-cutting token saver) |
| `UserPromptSubmit` hook (zero-cost drain) | D | Already covered by their push-mode `notifications/claude/channel` — no port needed | n/a |
| `wake-peer` headless | D | Out of scope for daemon-bridged scenario (peer always live via TUI) | n/a |
| Roles + `--to role:reviewer` resolver | E | Resolver in daemon when routing; ambiguous role → error like Python | v2 — addressing |
| `requires_human` field + `escalate` verb | E | Add `requiresHuman: boolean` to `BridgeMessage`; daemon styles + emits special notification; new MCP tool `escalate` | v2 — policy |
| Append-only `messages.jsonl` + `events.jsonl` | A (storage) | New `src/audit-log.ts` module called by daemon on every BridgeMessage + lifecycle event; rotation; `transcript` MCP tool | new |
| Edit locks (`lock acquire/release/with-hold` + TTL + heartbeat) | locks | New `src/lock-manager.ts` + MCP tools `lock_acquire`, `lock_release`; daemon-managed | new |
| Presence heartbeat (graceful vs crash) | presence | Extend `TuiConnectionState` with explicit heartbeat metadata (pid, host, role, version); surface via `status` | extends existing |
| Display codec / `inbox --human` | C/F | Local TS function `expandForDisplay()` for human-readable rendering inside MCP tool outputs | new (display only) |

## Sequencing (proposed)

Smallest-coherent-change discipline. Each step ships a PR with both unit and e2e tests; `bun run check` green.

### Step 1 — Audit log (durable storage)

Smallest piece that doesn't touch the routing core. Adds:
- `src/audit-log.ts` — atomic append, rotate by size
- daemon hook: on every BridgeMessage in/out + lifecycle event → append
- new MCP tool `transcript(sinceMs?, limit?)`

**Why first:** zero protocol changes. Pure additive. Builds confidence with the codebase.

### Step 2 — Agent Registry + capability handshake

Replaces today's hardcoded "single claude + single codex" with v2's registry. Minimal surface initially:
- Extend control-protocol `claude_connect` → `agent_register {agentId, agentType, capabilities, role?}`
- Registry data structure in daemon (`Map<agentId, AgentRecord>`)
- Backward-compat: missing `agentId` → synthesize `"claude-default"` (matches current behavior)

**Why second:** unblocks every later piece. Aligns with their stated v2 priority.

### Step 3 — Roles + role:&lt;name&gt; addressing

- Add `role` field on agent registration
- Add `role:reviewer`-style addressing resolver
- `reply` tool gets an optional `to` param (default still "codex" for backward-compat)

### Step 4 — `requires_human` + escalate

- Schema field on BridgeMessage
- New MCP tool `escalate(msg_id, reason, audience)`
- Daemon styles `[NEEDS-HUMAN]` and emits special notification

### Step 5 — async dispatch / collect

- New MCP tools `dispatch(to, tag, prompt, requireReply?)` + `collect(tag, waitMs?)`
- Backed by audit-log scan (from Step 1)
- Useful for "send + keep working" pattern

### Step 6 — Terse codec

- `format: "terse" | "human" | "json"` arg on `get_messages`, `transcript`, `collect`
- `expandForDisplay()` local function for human view
- Document token savings in skill/docs

### Step 7 — Edit locks

- `src/lock-manager.ts` — TTL + heartbeat + reap, file-backed under state dir
- MCP tools `lock_acquire(path, ttl, reason?)`, `lock_release(path)`, `lock_with_hold(path, command)`

### Step 8 — Presence enrichment

- Add pid/host/role/version to TuiConnectionState snapshot
- Surface via existing `status` tool
- Graceful-shutdown vs crash distinction tests

### Step 9 — Rooms / multi-pair

- Room Manager in daemon (per v2 spec)
- Multi-claude / multi-codex / multi-room support
- Lift fixed-ports restriction

## Risks / open questions

- **Build pipeline:** Bun → TS → `dist/` + `plugins/.../server/*.js`. Need to confirm CI publishes both on every PR. (Read `scripts/verify-plugin-sync.cjs` next.)
- **MCP notification budget:** push notifications eat tokens. The Python `--terse` codec optimization needs to land on push-mode too (not just `get_messages`).
- **Audit log file growth:** rotation strategy? Per-session file? Single file with truncation? Need to pick — Python project used append-only `.jsonl` with no rotation (worked for short sessions, would explode for long-running daemons).
- **Locks vs proxy ordering:** Codex spawns child shell processes. If we lock a file from the bridge but codex writes through `apply_patch` independently, the lock is informational, not enforcement. Document this clearly.
- **Backward-compat policy:** how many releases do we keep `reply()` working with implicit `"codex"` recipient before requiring explicit `to`?

## Pre-flight checks before any code change

1. `bun install` (already done — 96 packages)
2. `bun run check` (typecheck + tests + plugin sync + version match) — confirm green baseline
3. Branch from `master`: `git checkout -b feat/<short-name>`
4. Read the **specific** module being touched end-to-end (don't pattern-match from this doc — implementations evolve)
5. Add tests **first**, then make them pass
6. Run `bun run build:plugin` before any end-to-end test using `agentbridge claude` / `agentbridge codex`
7. PR with both unit + e2e plan, bilingual commit message
