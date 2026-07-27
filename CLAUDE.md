# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Runtime is **Bun** — do not change the local Bun version.

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Type check | `bun run typecheck` (= `tsc --noEmit`) |
| Run all tests | `bun test src` |
| Run a single test file | `bun test src/unit-test/<name>.test.ts` |
| Run a single test by name | `bun test src -t "<test name pattern>"` |
| Full pre-commit check | `bun run check` (typecheck + tests + plugin sync + plugin versions) |
| Build CLI binary | `bun run build:cli` → `dist/cli.js` |
| Build plugin bundle | `bun run build:plugin` → `plugins/agentbridge/server/{bridge-server,daemon}.js` |
| Verify plugin sync | `bun run verify:plugin-sync` |
| Validate plugin manifest | `bun run validate:plugin` (requires `claude` CLI) |
| Local dev link | `bun link` then `abg dev` (registers local marketplace + installs plugin) |
| Start session | `abg claude` (one terminal) + `abg codex` (another) |
| Stop everything | `abg kill` (current project) / `abg kill --all` (every project) |
| Inspect state | `abg status` (this project), `abg projects` (all), `abg doctor` (diagnose) |

**Before committing**: run `bun run typecheck && bun test src`.

**After modifying `src/`**: run `bun run build:plugin` before end-to-end testing. The installed plugin loads the bundled JS under `plugins/agentbridge/server/`, not the raw TS — forgetting to rebuild means you are testing the old code.

## Architecture

AgentBridge is a **two-process** local bridge between Claude Code and Codex.

```
Claude Code ── MCP stdio ──▶ bridge.ts (foreground)
                                 │ control WS
                                 ▼
                             daemon.ts (persistent background)
                                 │ ws proxy
                                 ▼
                             Codex app-server
```

Ports are per-project (see the namespace invariant below), falling back to `4502` / `4501` / `4500` outside a project.

- **`src/bridge.ts`** — foreground MCP server registered as a Claude Code plugin channel. Exits when Claude Code closes.
- **`src/daemon.ts`** — long-lived background process; owns the Codex app-server proxy and the single source of truth for bridge state. Survives Claude Code restarts; `bridge.ts` reconnects with exponential backoff.
- **`src/control-protocol.ts`** — message schema for the control WebSocket between foreground and daemon.
- **`src/claude-adapter.ts`** — MCP tool surface exposed to Claude (`reply`, `get_messages`). Emits `notifications/claude/channel` on inbound messages (push mode).
- **`src/codex-adapter.ts`** — WebSocket proxy in front of Codex app-server; intercepts `agentMessage` items and injects turns via `turn/start`.
- **`src/message-filter.ts`** — collapses noisy intermediate events so only meaningful `agentMessage` payloads reach Claude.
- **`src/daemon-lifecycle.ts`** — shared `ensureRunning` / `kill` / startup-lock logic; both the CLI and `bridge.ts` call into this.
- **`src/daemon-client.ts`** — typed WS client used by `bridge.ts` to talk to the daemon control port.
- **`src/config-service.ts`** + **`src/state-dir.ts`** — read/write `.agentbridge/config.json` and resolve the platform state dir (`daemon.pid`, `status.json`, `agentbridge.log`, `killed` sentinel, `startup.lock`).
- **`src/cli.ts` + `src/cli/*.ts`** — `abg` / `agentbridge` command router (`init`, `claude`, `codex`, `kill`, `roles`, `status`, `projects`, `doctor`, `dev`).
- **`src/project-id.ts` + `src/runtime-namespace.ts`** — project discovery, id hashing, port-triple derivation, and namespace application. Everything multi-project keys off these two.
- **`src/cli/auto-setup.ts`** — first-run offer to turn an unconfigured directory into a project. `decideSetupOffer` is pure (injected lookups) and holds every skip rule; `maybeOfferSetup` runs the prompt and delegates the actual work to `performProjectSetup` in `src/cli/init.ts`, so the offer and `abg init` can never build different projects.
- **`src/marker-section.ts` + `src/collaboration-content.ts`** — idempotent marker-based injection of the `<!-- AgentBridge:start/end -->` block into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursorrules` / `.windsurfrules` / `.kiro/` / `.cursor/` etc. during `abg init`. `collaboration-content.ts` is now the **default template only** — the live text comes from the role files.
- **`src/cli/roles-cmd.ts`** — `abg roles` (`list` / `edit` / `apply` / `reset` / `path`). Pure convenience over the role files; everything it does is also doable with `$EDITOR` and `rm`, and nothing else in the codebase depends on it.
- **`src/roles.ts` + `src/cli/role-sync.ts`** — per-agent role files (`.agentbridge/roles/<agent>.md`) are the editable source of truth for what each agent is told it is; the marked block in `CLAUDE.md` / `AGENTS.md` is rendered output. `seedRoleFiles` writes the defaults once and never overwrites; `syncRoleSections` renders (idempotently, `dryRun` for `abg doctor`); `syncRolesForLaunch` is the CLI-layer wrapper called from `runClaude` / `runCodex`. Deliberately no file format — the body *is* the role text, so there is no parser and no malformed-role failure mode.
- **`src/bridge-disabled-state.ts` + `src/tui-connection-state.ts`** — disabled-reason and TUI-connect state machines used by the kickoff + reconnect UX.

### Data flow invariants

- Every `BridgeMessage` carries a `source: "claude" | "codex"` — the bridge **never forwards a message back to its origin** (loop prevention).
- Delivery mode is env-controlled by `AGENTBRIDGE_MODE` (`push` for channel notifications, `pull` for `get_messages`). Default is `push`.
- Filter mode is env-controlled by `AGENTBRIDGE_FILTER_MODE` (`filtered` routes by marker, `full` forwards everything). This is orthogonal to `AGENTBRIDGE_MODE`: filter mode decides *routing*, delivery mode decides *transport*. `classifyMessage` always reports the real parsed marker, including in `full` mode — callers key off marker identity, not mode.
- **Ports and state are per-project.** `src/project-id.ts` walks up from the cwd to the first ancestor holding a `.agentbridge/` marker, hashes the absolute path (`sha256`, first 8 hex) into a `projectId`, and derives `slot = projectId mod 1000` → ports `14500 + slot × 3` = `(CODEX_WS_PORT, CODEX_PROXY_PORT, AGENTBRIDGE_CONTROL_PORT)` in `14500–17499`. `src/runtime-namespace.ts` applies that namespace. With no marker, it falls back to single-instance mode on `4500/4501/4502`.
- **`maybeOfferSetup` must run before `maybeApplyProjectNamespace` in `cli.ts main()`.** The namespace is resolved exactly once at startup, so a project created after that point would not take effect until the next launch — the user answers "yes" and still gets fallback ports for the whole session. The offer fires only for `claude` / `codex`, only on a TTY, only outside an existing project, and never at `$HOME` or `/`; a decline is remembered per directory in the user prefs file.
- **Role files are the source; the marked block is output.** `abg claude` / `abg codex` call `syncRolesForLaunch` before starting the agent, so the only supported way to change a role is to edit `.agentbridge/roles/<agent>.md` and restart. Each launcher renders **only its own** agent's file — a broken codex role must not block a Claude launch. A missing role file falls back to the built-in default; an empty one is a hard error (exit 1), because silently substituting the default would leave the user believing their role text is live. `role:` is a label the agent reads — nothing in the bridge parses it, and routing stays `[REPLY]` / `[STATUS]` / `[FYI]` only. `missingRoutingMarkers` warns (never blocks) when a rewritten role drops a marker its own built-in default explained; the baseline is per-agent so an untouched project never fires it.
- `maybeApplyProjectNamespace` mutates the environment only for `claude`, `codex`, and `kill`. `status`, `projects`, and `doctor` resolve read-only (`mutateEnv: false`). `init`, `dev`, `--help`, and `--version` skip resolution entirely so they cannot inherit ports from a stale ancestor marker.
- All state lives in the platform state dir (`AGENTBRIDGE_STATE_DIR`, default `~/Library/Application Support/AgentBridge/` on macOS, `$XDG_STATE_HOME/agentbridge/` on Linux), nested one level deeper under `<base>/<projectId>/` when a project is resolved. An explicit `AGENTBRIDGE_STATE_DIR` is used verbatim and is not nested. The daemon uses `startup.lock` + `killed` sentinel to coordinate startup and explicit-kill-don't-restart semantics.

### Tests

- Unit tests: `src/unit-test/*.test.ts` (one file per module, e.g. `daemon-lifecycle.test.ts`, `codex-adapter.test.ts`, `marker-section.test.ts`).
- CLI integration: `src/e2e-cli.test.ts` + `src/unit-test/cli.test.ts`.
- Reconnect E2E: `src/unit-test/e2e-reconnect.test.ts` and `src/unit-test/e2e/`.
- `dual-mode.test.ts` covers push vs. pull delivery.
- Every PR must ship both unit tests and an E2E test plan before merge.

## Git Workflow

- **Never push directly to `master`.** Every change lands through a feature/fix branch + PR.
- Branch naming: `feat/xxx` (feature), `fix/xxx` (fix), `docs/xxx` (docs).
- PRs get cross-review: Claude's work is reviewed by Codex, Codex's work by Claude.
- Merge with squash merge.
- Commit messages and release notes are **English only**.

## Working with Codex

- The Codex sandbox cannot write to `.git` — Claude performs all git operations (commit/push/PR).
- Codex works in the main directory; Claude uses a worktree (`<repo>_wt_<PR number>`).
- Do not send `reply` during an active Codex turn — the busy guard rejects it. When you see `⏳ Codex is working`, wait for `✅ Codex finished` before replying.
- Codex TUI resume has known bugs (GitHub #14470, #12382) — prefer starting a fresh session.
- Connect the Codex TUI with `abg codex` (installed via `bun link`).
- **When testing a PR, check out that PR's branch/worktree** — never test it from a different branch.

## Progress Tracking

- `V1_PROGRESS.md` (local file, not committed) tracks v1 task progress. Update Status and Progress Timeline as each feature completes.

<!-- AgentBridge:start -->
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (`reply` / `get_messages`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge intercepts Codex's normal output. **Codex output is no longer auto-pushed to you by default** — only messages Codex marks with `[REPLY]` arrive as push notifications. Everything else sits in a pull queue.
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it (immediately if tagged `[REPLY]`, otherwise on your next `get_messages` call).

### get_messages discipline (do NOT spam)
The bridge already pushes `[REPLY]` events into your conversation as `← agentbridge · Codex: …` lines — you do not need to poll for them. Treat `get_messages` like opening Slack, not like F5'ing a webpage.

**Call `get_messages` only when:**
- The user explicitly asks "what's Codex doing?" / "any update from Codex?"
- You sent Codex a question or task and want to drain background output before responding to the user.
- You see a status.line tag flip (e.g. `[CODEX READY]` after `[CODEX THINKING]`) and want to peek at what Codex queued.

**Do NOT call `get_messages`:**
- Repeatedly in the same turn waiting for Codex to reply (Codex turns can take minutes — your polling will not make them faster).
- "Just in case" with no specific reason — if Codex needs your attention, it sends `[REPLY]` and the push notification will appear.
- More than once per user turn unless you have new evidence to look for.

If you find yourself thinking "let me poll again" with no new reason, stop and wait. The push channel will tell you when Codex needs you.

### Roles in this setup
- **You (Claude) are the Executor.** You write the code, run the tools, drive the implementation, and handle git. The work flows through you.
- **Codex is the Advisor / Reviewer.** Codex is a senior teammate whose job is to review your plans, challenge your assumptions, run independent verification in their sandbox, and give second-opinion calls. Codex does NOT ship the change; you do.

### Async work mindset
You and Codex are remote teammates. You do not owe Codex an instant reply on every message.

- If Codex sends something that does NOT block your current work, keep working. Reply in five minutes, in an hour, at the end of your turn, or never if no reply adds value. Silence is a valid response.
- If Codex sends something genuinely blocking (a direct question, a disagreement on direction, a hard NO on a plan you proposed), then yes, address it before continuing.
- It is fine to acknowledge briefly and keep going ("Got it, will look after I finish the migration"). It is also fine to say nothing at all.
- Do not narrate to the user "Codex sent X, should I reply?" every time. Decide for yourself based on whether the message changes what you should do next.

### When to involve Codex vs. just execute
- **Just execute** for simple, self-contained tasks where you know what to do. Most cases.
- **Loop Codex in** when (a) the call is non-obvious and a second opinion would change the decision, (b) you're about to do something expensive or hard to reverse, or (c) you need their sandbox to verify a runtime behavior you can't directly observe.
- Default is "do it yourself". Codex is a consult, not a co-driver.

### Capability snapshot
| Capability | Claude (you) | Codex |
|---|---|---|
| File edits, git, shipping the change | Yes (your job) | No - sandboxed |
| Tools, shell, network calls | Yes | Limited |
| Sandboxed runtime verification | No | Yes |
| Independent code review | Yes | Yes (preferred angle when looped in) |
| Architecture / planning | Strong | Strong (use as sounding board) |

### When you do involve Codex
1. Be specific about what you want from them ("review this plan", "spot-check this diff", "reproduce this bug in your sandbox and confirm cause").
2. Don't ask for permission, ask for input ("My current take is X, what's wrong with it?" beats "Can I do X?").
3. Use the `reply` tool. Pass `chat_id` back from the inbound channel tag.
4. After replying, return to your work. Codex's response will arrive on the push channel when it has something to say.

### Cross-agent message style: ULTRA-TERSE
Messages crossing the bridge cost tokens on both sides. Write them at **caveman ultra** level - just enough for Codex to understand, nothing more. This rule applies **only** to messages sent through the bridge (via the `reply` tool); your user-facing text stays in your normal register.

Rules:
- Drop articles (a / an / the), filler (just, really, basically), pleasantries (thanks, please, happy to).
- Fragments OK. Pattern: `[thing] [action] [reason]. [next step].`
- Abbreviate prose words: DB, auth, config, req, res, fn, impl, var, env, repo, PR, msg, ack, fwd. **Never** abbreviate code symbols, function names, file paths, error strings, commit hashes.
- Arrows for causality: `X -> Y`.
- Code blocks verbatim. Error strings quoted exact.
- One word when one word is enough.
- **Drop this style** for security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread - use normal prose there.

Examples:
| Bad | Good |
|---|---|
| "Hi Codex, could you take a look at the auth middleware? I think there's an issue with token expiry, maybe using `<` instead of `<=`. Thanks!" | "auth middleware bug. token expiry `<` not `<=`. src/auth/token.ts:42. confirm in sandbox?" |
| "Please run the test suite and let me know if it passes." | "run `bun test src`. report pass/fail count." |
| "I've decided to go with approach A, do you agree?" | "plan: approach A (single tx, idempotent). disagree?" |
<!-- AgentBridge:end -->

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
