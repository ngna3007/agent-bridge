# AgentBridge

[![CI](https://github.com/ngna3007/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ngna3007/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

Local bridge for bidirectional communication between Claude Code and Codex inside the same working session.

AgentBridge uses a two-process architecture:

- **bridge.ts** is the foreground MCP client started by Claude Code via the AgentBridge plugin
- **daemon.ts** is a persistent local background process that owns the Codex app-server proxy and bridge state

When Claude Code closes, the foreground MCP process exits while the background daemon and Codex proxy keep running. When Claude Code starts again, it reconnects automatically with exponential backoff.

## What this project is / is not

**This project is:**

- A local developer tool for connecting Claude Code and Codex in one workflow
- A bridge that forwards messages between an MCP channel and the Codex app-server protocol
- An experimental setup for human-in-the-loop collaboration between multiple agents

**This project is not:**

- A hosted service or multi-tenant system
- A generic orchestration framework for arbitrary agent backends
- A hardened security boundary between tools you do not trust

## Architecture

```
┌──────────────┐     MCP stdio / plugin     ┌────────────────────┐
│ Claude Code  │ ──────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀──────────────────────────  │ foreground client  │
└──────────────┘                             └─────────┬──────────┘
                                                       │
                                                       │ control WS (:4502)
                                                       ▼
                                             ┌────────────────────┐
                                             │ daemon.ts          │
                                             │ bridge daemon      │
                                             └─────────┬──────────┘
                                                       │
                                     ws://127.0.0.1:4501 proxy
                                                       │
                                                       ▼
                                             ┌────────────────────┐
                                             │ Codex app-server   │
                                             └────────────────────┘
```

### Data flow

| Direction | Path |
|-----------|------|
| **Codex -> Claude** | `daemon.ts` captures `agentMessage` -> control WS -> `bridge.ts` -> `notifications/claude/channel` |
| **Claude -> Codex** | Claude calls the `reply` tool -> `bridge.ts` -> control WS -> `daemon.ts` -> `turn/start` injects into the Codex thread |

### Loop prevention

Each message carries a `source` field (`"claude"` or `"codex"`). The bridge never forwards a message back to its origin.

## Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| [Bun](https://bun.sh) | v1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **Note:** Bun is required as the runtime for the AgentBridge daemon and plugin server. Node.js alone is not sufficient.

## Quick Start

### Install via Plugin Marketplace (recommended)

Install AgentBridge directly from Claude Code using the plugin marketplace:

```bash
# 1. In Claude Code, add the AgentBridge marketplace
/plugin marketplace add ngna3007/agent-bridge

# 2. Install the plugin
/plugin install agentbridge@agentbridge

# 3. Reload plugins to activate
/reload-plugins
```

Then install the CLI tool:

```bash
# 4. Install the CLI globally
npm install -g @rowanng/agentbridge

# 5. Generate project config (optional)
abg init

# 6. Start Claude Code with AgentBridge channel enabled
abg claude

# 7. Start Codex TUI connected to the bridge (in another terminal)
abg codex
```

> **Tip:** `abg` is a short alias for `agentbridge`. Both commands are identical — use whichever you prefer.

That's it. The daemon starts automatically when needed and reconnects if restarted.

#### Updating the plugin

When a new version is released, update from Claude Code:

```bash
/plugin marketplace update agentbridge
/reload-plugins
```

Or enable auto-update: run `/plugin` → **Marketplaces** tab → select **agentbridge** → **Enable auto-update**.

### Install for local development

If you want to modify AgentBridge source code, use the local development setup instead:

```bash
# 1. Clone and install dependencies
git clone https://github.com/ngna3007/agent-bridge.git
cd agent-bridge
bun install
bun link

# 2. Set up local plugin + project config
agentbridge dev     # Register local marketplace + install plugin
agentbridge init    # Check dependencies, generate .agentbridge/config.json

# 3. Start Claude Code with AgentBridge plugin loaded
agentbridge claude

# 4. Start Codex TUI connected to the bridge (in another terminal)
agentbridge codex
```

> **Note:** `agentbridge claude` injects `--dangerously-load-development-channels plugin:agentbridge@agentbridge` automatically. This loads a local development channel into Claude Code (currently a Research Preview workflow). Only enable channels and MCP servers you trust.

#### Updating after code changes

After modifying AgentBridge source code, re-run `agentbridge dev` to sync changes to the plugin cache, then restart Claude Code or run `/reload-plugins` in an active session.

## CLI Reference

> All commands work with both `agentbridge` and the short alias `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Install plugin, check dependencies (bun/claude/codex), generate `.agentbridge/config.json` |
| `abg claude [args...]` | Start Claude Code with push channel enabled. Clears any killed sentinel from a previous `kill`. Pass-through args are forwarded to `claude` |
| `abg codex [args...]` | Start Codex TUI connected to AgentBridge daemon. Manages TUI process lifecycle (pid tracking, cleanup). Pass-through args forwarded to `codex` |
| `abg kill` | Gracefully stop both daemon and managed Codex TUI, clean up state files, write killed sentinel |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg --help` | Show help |
| `abg --version` | Show version |

### Owned flags

Some flags are automatically injected and cannot be manually specified:

- `agentbridge claude` owns: `--channels`, `--dangerously-load-development-channels`
- `agentbridge codex` owns: `--remote`, `--enable tui_app_server`

Passing these flags manually will result in a hard error with guidance to use the native command directly.

> **Note on flag positioning for `agentbridge codex`:** For the bare TUI form
> (`agentbridge codex …`), bridge flags are injected at the front. For TUI
> subcommands that carry per-subcommand args (`resume`, `fork`), they are
> injected *after* the subcommand name (so clap parses them as options of the
> actually-invoked command, not the root). Non-TUI subcommands like `exec`,
> `mcp`, `plugin`, `remote-control`, `update` etc. are passed through
> unchanged — no bridge flags injected. See `src/cli/codex.ts buildCodexArgs`
> for the full positioning logic.

## Project Config

Running `agentbridge init` creates a `.agentbridge/` directory in your project root:

| File | Purpose |
|------|---------|
| `config.json` | Machine-readable project config (Codex ports, turn coordination, idle shutdown) |

The config is loaded by the CLI and daemon at startup. Re-running `init` is idempotent and will not overwrite existing files.

## File Structure

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug report and feature request templates
│   ├── pull_request_template.md
│   └── workflows/ci.yml          # GitHub Actions CI
├── assets/                        # Static assets (images, etc.)
├── docs/
│   ├── phase3-spec.md            # Phase 3 design spec (CLI + Plugin)
│   ├── v1-roadmap.md             # v1 feature roadmap
│   └── v2-architecture.md        # v2 multi-agent architecture design
├── plugins/agentbridge/           # Claude Code plugin bundle
│   ├── .claude-plugin/plugin.json
│   ├── commands/init.md
│   ├── hooks/hooks.json
│   ├── scripts/health-check.sh
│   └── server/                    # Bundled bridge-server.js + daemon.js
├── src/
│   ├── bridge.ts                  # Claude foreground MCP client (plugin entry point)
│   ├── daemon.ts                  # Persistent background daemon
│   ├── daemon-client.ts           # WebSocket client for daemon control port
│   ├── daemon-lifecycle.ts        # Shared daemon lifecycle (ensureRunning, kill, startup lock)
│   ├── control-protocol.ts        # Foreground/background control protocol types
│   ├── claude-adapter.ts          # MCP server adapter for Claude Code channels
│   ├── codex-adapter.ts           # Codex app-server WebSocket proxy and message interception
│   ├── config-service.ts          # Project config (.agentbridge/) read/write
│   ├── state-dir.ts               # Platform-aware state directory resolver
│   ├── message-filter.ts          # Smart message filtering (markers, summary buffer)
│   ├── types.ts                   # Shared types
│   ├── cli.ts                     # CLI entry point and command router
│   └── cli/
│       ├── init.ts                # agentbridge init
│       ├── claude.ts              # agentbridge claude
│       ├── codex.ts               # agentbridge codex
│       ├── kill.ts                # agentbridge kill
│       └── dev.ts                 # agentbridge dev
├── CLAUDE.md                      # Project rules for AI agents
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh-CN.md
├── SECURITY.md
├── package.json
└── tsconfig.json
```

## Fork features (additions over upstream)

This fork layers a set of quality-of-life additions on top of the [upstream](https://github.com/quilin-ai/agent-bridge) bridge. None of them change the core protocol; they are all opt-in or auto-detected.

### First-run welcome screen

`abg claude` shows a one-time intro screen on the user's first invocation. It prints an ASCII-art logo, a two-line description of what the bridge does, and a single "Got it - continue" confirmation. Pressing Esc aborts the launch silently (no Claude spawn, no state changes). The acknowledgement is persisted in `<state-dir>/user-prefs.json` so the screen never appears twice.

### Auto-wired statusbar

After the intro (and on every subsequent `abg claude` launch, idempotently), the bridge patches `~/.claude/settings.json` so its current state shows up in Claude Code's statusbar.

- The chain preserves any existing `statusLine.command` (e.g. caveman's hook) by composing the two commands: `{ <existing>; [ "$AGENTBRIDGE_ACTIVE" = "1" ] && { printf ' '; cat <state-dir>/status.line; }; } | tr -d '\n'`.
- The `$AGENTBRIDGE_ACTIVE` gate means plain `claude` / `claude -c` sessions see only the existing tag (no `[CODEX READY]` leaking into non-bridge sessions).
- The previous `settings.json` is copied to `settings.json.bak.<mtime>` before each write. The wirer keeps the 5 newest backups and prunes older ones.
- `AGENTBRIDGE_SETTINGS_PATH` overrides the target file (used by tests).

### Statusbar tags

The daemon writes a short colored tag to `<state-dir>/status.line` on every lifecycle event:

| Event | Tag | Color |
|---|---|---|
| Codex connected / idle / reconnected | `[CODEX READY]` | green |
| Codex mid-turn | `[CODEX THINKING]` | yellow |
| Daemon ready, waiting for Codex | `[WAITING FOR CODEX]` | yellow |
| Reconnecting | `[RECONNECTING]` | yellow |
| Bridge ready | `[BRIDGE READY]` | green |
| Daemon control connection dropped | `[BRIDGE OFFLINE]` | red |
| Daemon failed to start | `[BRIDGE FAILED]` | red |
| Codex failed to start | `[CODEX FAILED]` | red |
| Required reply missing | `[CODEX NO REPLY]` | red |
| Evicted by a newer session | `[REPLACED BY NEWER SESSION]` | red |
| Another session active | `[ANOTHER SESSION ACTIVE]` | red |
| Recovery exhausted | `[RECONNECT FAILED]` | red |
| `agentbridge kill` was run | `[BRIDGE STOPPED]` | dim |

These tags replace the in-band system notifications that the upstream bridge pushed into Claude's MCP channel. The MCP channel is now reserved exclusively for Codex's real `agentMessage` replies, keeping routine lifecycle events out of Claude's context.

### Opt-in env gate (`AGENTBRIDGE_ACTIVE`)

The agentbridge plugin is auto-loaded by every `claude` invocation -- the manifest controls that, not the bridge. The bridge MCP server self-exits at startup unless `AGENTBRIDGE_ACTIVE=1` is set in its environment. `abg claude` sets the flag on the spawned child; plain `claude` / `claude -c` do not. The result: only `abg`-launched sessions claim the daemon's single Claude slot, and stray editor or background sessions cannot accidentally hold it.

### Pinned bridge contract via `AGENTS.md`

`abg init` writes the BRIDGE_CONTRACT_REMINDER (Codex's role, the `[IMPORTANT]/[STATUS]/[FYI]` marker contract, the git-write prohibition) into `AGENTS.md`. Codex picks it up at session start as part of its system prompt, so the daemon no longer needs to re-append it to every Claude→Codex turn. `AGENTBRIDGE_PIN_CONTRACT=once|always` brings the legacy per-message append back if `AGENTS.md` is missing.

### Compact `<channel>` metadata

The `chat_id` and `message_id` values inside every inbound `<channel>` tag are shortened to a 4-hex random prefix plus a small sequence (e.g. `chat_id="c1a2b"`, `message_id="9c8d1"`). Roughly 30 chars saved per message in Claude's context.

### Rotating daemon log

`agentbridge.log` is now a rotating file with a hard size ceiling: defaults to 50 MB active + 3 generations (200 MB total). Tunable via `AGENTBRIDGE_LOG_MAX_BYTES` and `AGENTBRIDGE_LOG_MAX_FILES`. The writer is path-shared across all log sites (bridge, daemon, claude-adapter, codex-adapter, cli/codex), counts bytes in memory to avoid a stat per write, and rotates atomically.

### Companion-tool recommendations

The intro screen recommends two optional tools that play well with AgentBridge:

- [caveman](https://github.com/anthropics/skills) -- a Claude Code skill that asks Claude to reply in short fragment-style prose. Cuts output tokens roughly 30-60% per turn. Install via the Claude Code plugin marketplace.
- [rtk](https://github.com/anthropic-experimental/rtk) (Rust Token Killer) -- a CLI proxy that shrinks dev-command output (e.g. `git log` 1000 lines → 20-line summary) before Claude reads it. Install with `cargo install rtk` and add its shell hook.

AgentBridge does not install or configure either tool for you; the intro just points at them.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Control port between bridge.ts and daemon.ts |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | `3000` | Maximum wait for incumbent Claude pong before evicting on contention (issue #68) |
| `AGENTBRIDGE_STATE_DIR` | Platform default | State directory for pid, status, logs (macOS: `~/Library/Application Support/agentbridge/`, Linux: `$XDG_STATE_HOME/agentbridge/`) |
| `AGENTBRIDGE_MODE` | `push` | Message delivery mode (`push` for channels, `pull` for API key mode) |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | Override daemon entry point (used by plugin bundles) |
| `AGENTBRIDGE_ACTIVE` | unset | Opt-in gate read by the bridge MCP plugin. `abg claude` sets this in the spawned child's env; plain `claude` / `claude -c` invocations do not, and their bridge plugin self-exits before claiming the daemon's single Claude slot. Set to `1` manually only if you want a non-`abg` Claude session to attach to the bridge. |
| `AGENTBRIDGE_SETTINGS_PATH` | `~/.claude/settings.json` | Path to the Claude Code settings file that `wireStatusLine` patches. Tests and headless harnesses set this to redirect off the real settings. |
| `AGENTBRIDGE_LOG_MAX_BYTES` | `50_000_000` | Per-file size cap for `agentbridge.log` before rotation kicks in. Values below 1 KiB fall back to the default. |
| `AGENTBRIDGE_LOG_MAX_FILES` | `3` | How many rotated `agentbridge.log.N` generations to retain. |
| `AGENTBRIDGE_PIN_CONTRACT` | `off` | When `once` (the legacy mid-state) or `always`, the daemon re-appends the BRIDGE_CONTRACT_REMINDER to every Claude→Codex turn. Default `off` because `abg init` writes the same content into `AGENTS.md` so it lives in Codex's system prompt and survives `/compact`. |

### State Directory

The daemon stores runtime state in a platform-aware directory:

| Platform | Default Path |
|----------|-------------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/` (fallback: `~/.local/state/agentbridge/`) |

Contents: `daemon.pid`, `status.json`, `agentbridge.log`, `killed` (sentinel), `startup.lock`

### Disabled Bridge States

The bridge can enter several dormant states when it cannot accept new MCP replies. Each state surfaces to the agent as an error message (and, for the transient ones, an in-band push notification):

| State | Cause | Recovery |
|-------|-------|----------|
| `killed` | `agentbridge kill` was run, sentinel file present. | Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume`. |
| `rejected` | Daemon rejected the connection: another Claude session is already attached. | Close the other session, or run `agentbridge kill` to reset, then `agentbridge claude` again. |
| `evicted` | A newer session evicted this one after the incumbent failed a liveness probe (issue #68). | Close this session and start a fresh one with `agentbridge claude`. |
| `probe_in_progress` | A liveness probe is currently checking the incumbent — contention window. Transient (auto-recovers within `DISABLED_RECOVERY_INTERVAL_MS` × cap, ~30 s). | None needed; the recovery poller reconnects automatically when the slot clears. |
| `auto_recovery_exhausted` | The auto-recovery poller for `probe_in_progress` ran its full retry budget (6 attempts, ~30 s) without succeeding. Terminal. | Retry manually with `agentbridge claude`. |

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- Single Codex thread, no multi-session support yet
- Single Claude foreground connection; a new Claude session replaces the previous one
- Fixed ports mean only one AgentBridge instance per machine (multi-project support planned for post-v1)

### Codex git restrictions

Codex runs in a sandboxed environment that **blocks all writes to the `.git` directory**. This means Codex cannot run `git commit`, `git push`, `git pull`, `git checkout -b`, `git merge`, or any other command that modifies git metadata. Attempting these commands will cause the Codex session to hang indefinitely.

**Recommendation:** Let Claude Code handle all git operations (branching, committing, pushing, creating PRs). Codex should focus on code changes and report completed work via `agentMessage`, then Claude Code takes care of the git workflow.

## Roadmap

- **v1.x (current)**: Improve the single-bridge experience without architectural refactoring -- less noise, better turn discipline, and clearer collaboration modes. See [docs/v1-roadmap.md](docs/v1-roadmap.md).
- **v2 (planned)**: Introduce the multi-agent foundation -- room-scoped collaboration, stable identity, a formal control protocol, and stronger recovery semantics. See [docs/v2-architecture.md](docs/v2-architecture.md).
- **v3+ (longer term)**: Explore smarter collaboration, richer policies, and more advanced orchestration across runtimes.

## How This Project Was Built

This project was built collaboratively by **Claude Code** (Anthropic) and **Codex** (OpenAI), communicating through AgentBridge itself -- the very tool they were building together. A human developer coordinated the effort, assigning tasks, reviewing progress, and directing the two agents to work in parallel and review each other's output.

In other words, AgentBridge is its own proof of concept: two AI agents from different providers, connected in real time, shipping code side by side.

## Upstream

This fork (`@rowanng/agentbridge`) tracks [quilin-ai/agent-bridge](https://github.com/quilin-ai/agent-bridge) (`@raysonmeng/agentbridge` on npm). The upstream project is the canonical implementation; this fork layers onboarding UX, statusbar integration, opt-in env gating, log rotation, and other quality-of-life changes on top.
