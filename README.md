# AgentBridge

[![CI](https://github.com/ngna3007/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ngna3007/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
                                                       │ control WS
                                                       ▼
                                             ┌────────────────────┐
                                             │ daemon.ts          │
                                             │ bridge daemon      │
                                             └─────────┬──────────┘
                                                       │
                                              ws://127.0.0.1 proxy
                                                       │
                                                       ▼
                                             ┌────────────────────┐
                                             │ Codex app-server   │
                                             └────────────────────┘
```

All three ports are derived per project — see [Multi-project](#multi-project). Outside a project they fall back to `4502` (control), `4501` (proxy), and `4500` (app-server).

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

# 5. Start Claude Code with AgentBridge channel enabled
abg claude

# 6. Start Codex TUI connected to the bridge (in another terminal)
abg codex
```

> **Tip:** `abg` is a short alias for `agentbridge`. Both commands are identical — use whichever you prefer.

The first `abg claude` (or `abg codex`) in a directory that is not yet an AgentBridge project offers to set one up — answer yes and you never need to run `abg init` by hand. See [First-run setup](#first-run-setup).

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
abg dev     # Register local marketplace + install plugin
abg init    # Check dependencies, generate .agentbridge/config.json

# 3. Start Claude Code with AgentBridge plugin loaded
abg claude

# 4. Start Codex TUI connected to the bridge (in another terminal)
abg codex
```

> **Note:** `abg claude` injects `--dangerously-load-development-channels plugin:agentbridge@agentbridge` automatically. This loads a local development channel into Claude Code (currently a Research Preview workflow). Only enable channels and MCP servers you trust.

#### Updating after code changes

After modifying AgentBridge source code, re-run `abg dev` to sync changes to the plugin cache, then restart Claude Code or run `/reload-plugins` in an active session.

## CLI Reference

> Every command works under both names: `abg` (short) and `agentbridge` (long). The docs below use `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Per-project setup: install plugin, check dependencies (bun/claude/codex), generate `.agentbridge/config.json` with this project's port triple. Optional — `claude` / `codex` offer to do it on first run |
| `abg claude [args...]` | Start Claude Code with push channel enabled. Offers [first-run setup](#first-run-setup) in an unconfigured directory. Clears any killed sentinel from a previous `kill`. Pass-through args are forwarded to `claude` |
| `abg codex [args...]` | Start Codex TUI connected to the AgentBridge daemon. Offers [first-run setup](#first-run-setup) in an unconfigured directory. Manages TUI process lifecycle (pid tracking, cleanup). Pass-through args forwarded to `codex` |
| `abg kill [--all]` | Gracefully stop the daemon + managed Codex TUI **for the current project**, clean up state files, write the killed sentinel. `--all` does it for every project on the machine |
| `abg roles [sub]` | See or change [what each agent is told it is](#agent-roles). `list` (default), `edit <agent>`, `apply`, `reset <agent>`, `path <agent>` |
| `abg status` | Read-only: which project the cwd resolves to, its daemon state, and its ports |
| `abg projects` | List every project state dir on this machine and each daemon's state |
| `abg doctor` | Diagnose stuck or surprising state and suggest fixes |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg --help` | Show help |
| `abg --version` | Show version |

`init`, `dev`, `--help`, and `--version` deliberately do **not** pick up a project namespace — they must not inherit ports from a stale ancestor `.agentbridge/`. `status`, `projects`, and `doctor` resolve the namespace read-only. Only `claude`, `codex`, and `kill` apply it to the environment.

### Owned flags

Some flags are automatically injected and cannot be manually specified:

- `abg claude` owns: `--channels`, `--dangerously-load-development-channels`
- `abg codex` owns: `--remote`, `--enable tui_app_server`

Passing these flags manually will result in a hard error with guidance to use the native command directly.

> **Note on flag positioning for `abg codex`:** For the bare TUI form
> (`abg codex …`), bridge flags are injected at the front. For TUI
> subcommands that carry per-subcommand args (`resume`, `fork`), they are
> injected *after* the subcommand name (so clap parses them as options of the
> actually-invoked command, not the root). Non-TUI subcommands like `exec`,
> `mcp`, `plugin`, `remote-control`, `update` etc. are passed through
> unchanged — no bridge flags injected. See `src/cli/codex.ts buildCodexArgs`
> for the full positioning logic.

## Multi-project

Multiple projects run side by side on one machine. Each gets its own daemon, its own ports, and its own state directory.

Each project root needs a `.agentbridge/` marker directory — created either by answering yes to the [first-run prompt](#first-run-setup) or by running `abg init` there. The marker is what everything else keys off:

| Step | How |
|---|---|
| Find the project | Walk up from the cwd to the first ancestor containing `.agentbridge/` |
| Derive its id | `sha256(absolute root path)`, first 8 hex chars |
| Derive its ports | slot = `projectId` as hex mod 1000; ports = `14500 + slot × 3` → `(codexWs, codexProxy, control)`, i.e. somewhere in `14500–17499` |
| Derive its state dir | `<platform-default>/<projectId>/` |

`abg claude`, `abg codex`, and `abg kill` print a one-line banner to stderr on a TTY so you can see which project the terminal is bound to:

```
[abg] project a1b2c3d4 · ports 14712/14713/14714 · /home/you/work/my-project
```

With no `.agentbridge/` marker in the cwd or any ancestor, `abg` falls back to **single-instance mode** on the historical fixed ports `4500/4501/4502` and the un-nested state dir.

`abg status` shows the resolution for the current directory; `abg projects` lists every project on the machine.

### First-run setup

Single-instance mode works, which is the problem: without a marker there is nothing to tell you a better mode exists, and the second project you launch quietly takes the daemon slot from the first. So `abg claude` and `abg codex` ask, once, in any directory that is not yet a project:

```
Set up AgentBridge for this project?

  This directory is not set up as an AgentBridge project yet.
  ...
> Yes, set it up        same as `abg init`
  No, use shared mode   won't ask again here
```

- **Yes** runs exactly the same setup as `abg init`, then prints what you can customize (below), and the rest of that session already uses the new project's ports.
- **No** is remembered per directory, so you are asked once and never again there.
- The target is the **git root**, not the cwd — `abg claude` from `src/` sets up the repo, not `src/`.

The prompt never appears when any of these hold: the directory (or an ancestor) is already a project, the shell is not interactive, the target would be `$HOME` or `/`, or `AGENTBRIDGE_AUTO_SETUP=0` is set. In every one of those cases the historical single-instance fallback is used and nothing is written.

### What you can customize

The same list is printed at the end of setup:

| Where | What |
|---|---|
| `.agentbridge/roles/claude.md` · `.agentbridge/roles/codex.md` | What each agent is told it is — role, workflow, review discipline, message style. Plain prose, no format. See [Agent roles](#agent-roles) |
| `.agentbridge/config.json` | `codex.appPort` / `codex.proxyPort`, `turnCoordination.attentionWindowSeconds`, `idleShutdownSeconds` |
| `CLAUDE.md` · `AGENTS.md` | Text between the `<!-- AgentBridge:start/end -->` markers is **rendered output** — edit the role files instead. Anything outside the markers is yours and is never touched |
| Environment | [Every variable in the table below](#environment-variables) — most usefully `AGENTBRIDGE_FILTER_MODE=full` and `AGENTBRIDGE_MODE=pull` |

`abg doctor` checks all of the above for drift.

### Agent roles

Setup seeds `.agentbridge/roles/claude.md` and `.agentbridge/roles/codex.md` with the built-in defaults (Claude executes, Codex reviews) and never overwrites them again. Each file's body *is* the role text — no frontmatter, no presets, nothing to get wrong.

```bash
abg roles              # what is each agent running on, and is it live?
abg roles edit codex   # opens the role file in $EDITOR, then re-renders
abg codex              # restart — the new role takes effect
```

`abg roles edit` is a convenience; the files are plain markdown, so `$EDITOR .agentbridge/roles/codex.md` followed by `abg codex` does the same thing.

| Subcommand | What it does |
|---|---|
| `abg roles` | Per agent: the file, whether it's stock or yours, whether the rendered block is live or stale, and whether a rewrite dropped the routing markers |
| `abg roles edit <agent>` | Creates the file from the default if missing, opens `$EDITOR`, re-renders on save |
| `abg roles apply` | Re-render now, without restarting — useful after editing files by hand |
| `abg roles reset <agent>` | Restore the built-in default. Prompts before discarding your text (`--force` to skip) |
| `abg roles path <agent>` | Print the path, for scripting |

- `abg claude` re-renders `CLAUDE.md`; `abg codex` re-renders `AGENTS.md`. Only the launching agent's file is touched, and only when the rendered block actually differs.
- Instructions are read at agent startup, so an edit reaches a running agent only after a restart. `abg doctor` reports `role section is out of date` until then.
- Delete a role file to fall back to the built-in default. An **empty** file is treated as an unfinished edit and aborts the launch instead of silently using the default.
- Rewriting a role is allowed to say anything — but if the new text stops explaining the `[REPLY]` / `[STATUS]` / `[FYI]` markers, `abg roles` and `abg doctor` warn, because an agent that stops tagging its messages looks like a broken bridge rather than a role edit.
- Roles are text, not routing. `role:` is a label the agent reads; message delivery is decided by the markers and nothing else.

### Project config

`abg init` writes into `.agentbridge/`:

| Path | Purpose |
|------|---------|
| `config.json` | Machine-readable project config (Codex ports, turn coordination, idle shutdown) |
| `roles/<agent>.md` | Per-agent role text, rendered into `CLAUDE.md` / `AGENTS.md` on every launch |

The config is loaded by the CLI and daemon at startup. Re-running `init` is idempotent and will not overwrite existing files.

## File Structure

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug report and feature request templates
│   ├── pull_request_template.md
│   └── workflows/ci.yml          # GitHub Actions CI
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
│   ├── app-server-protocol.ts     # Codex app-server JSON-RPC message shapes
│   ├── claude-adapter.ts          # MCP server adapter for Claude Code channels
│   ├── codex-adapter.ts           # Codex app-server WebSocket proxy and message interception
│   ├── project-id.ts              # Project discovery, id hash, per-project port allocation
│   ├── runtime-namespace.ts       # Resolves project + state dir + control port per command
│   ├── config-service.ts          # Project config (.agentbridge/) read/write
│   ├── state-dir.ts               # Platform-aware state directory resolver
│   ├── message-filter.ts          # Marker classification, routing, status buffer
│   ├── marker-section.ts          # Idempotent <!-- AgentBridge:start/end --> section upsert
│   ├── collaboration-content.ts   # CLAUDE.md / AGENTS.md collaboration sections (hardcoded)
│   ├── settings-wire.ts           # Chains the statusbar command into ~/.claude/settings.json
│   ├── status-line-writer.ts      # Writes the colored lifecycle tag to status.line
│   ├── lifecycle-tags.ts          # Tag constants and colors
│   ├── log-rotator.ts             # Size-capped rotating logger shared by all log sites
│   ├── liveness-probe.ts          # Ping/pong probe for challenge-on-contest admission
│   ├── bridge-disabled-state.ts   # killed / rejected / evicted state machine
│   ├── tui-connection-state.ts    # TUI connect/disconnect grace-period state machine
│   ├── stderr-ring-buffer.ts      # Bounded stderr tail kept for crash classification
│   ├── process-helpers.ts         # Spawn, pid tracking, orphan reaping
│   ├── user-prefs.ts              # First-run acknowledgement and other persisted prefs
│   ├── env-utils.ts               # Env parsing helpers
│   ├── types.ts                   # Shared types
│   ├── cli.ts                     # CLI entry point and command router
│   └── cli/
│       ├── init.ts                # abg init
│       ├── claude.ts              # abg claude
│       ├── codex.ts               # abg codex
│       ├── kill.ts                # abg kill
│       ├── status.ts              # abg status
│       ├── projects.ts            # abg projects
│       ├── doctor.ts              # abg doctor
│       ├── dev.ts                 # abg dev
│       ├── prompt.ts              # Interactive prompts (onboarding wizard, agent picker)
│       └── pkg-root.ts            # Locates the installed package root
├── CLAUDE.md                      # Project rules for AI agents
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
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
| `abg kill` was run | `[BRIDGE STOPPED]` | dim |

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

All of these override whatever the project namespace resolved. Setting a port variable by hand opts that process out of per-project allocation.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_WS_PORT` | project-derived, else `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | project-derived, else `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | project-derived, else `4502` | Control port between bridge.ts and daemon.ts |
| `AGENTBRIDGE_PROJECT_ID` | auto-set | The 8-hex project id, exported by the CLI so downstream processes agree on the namespace. Read, not usually set by hand |
| `AGENTBRIDGE_FILTER_MODE` | `filtered` | `filtered` routes by marker (`[REPLY]` forward, `[STATUS]` buffer, `[FYI]` drop, untagged queue). `full` forwards every Codex message to Claude |
| `AGENTBRIDGE_ATTENTION_WINDOW_MS` | `15000` | After a `[REPLY]`, how long `[STATUS]` traffic stays suppressed to give Claude room to respond |
| `AGENTBRIDGE_IDLE_SHUTDOWN_MS` | `30000` | How long the daemon lingers with no attached client before exiting |
| `AGENTBRIDGE_MAX_BUFFERED_MESSAGES` | `100` | Cap on messages buffered while no Claude client is attached |
| `TUI_DISCONNECT_GRACE_MS` | `2500` | Grace period before a TUI disconnect is reported to Claude as real |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | `3000` | Maximum wait for incumbent Claude pong before evicting on contention (issue #68) |
| `AGENTBRIDGE_STATE_DIR` | Platform default | State directory for pid, status, logs (macOS: `~/Library/Application Support/agentbridge/`, Linux: `$XDG_STATE_HOME/agentbridge/`) |
| `AGENTBRIDGE_MODE` | `push` | Message delivery mode (`push` for channels, `pull` for API key mode) |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | Override daemon entry point (used by plugin bundles) |
| `AGENTBRIDGE_ACTIVE` | unset | Opt-in gate read by the bridge MCP plugin. `abg claude` sets this in the spawned child's env; plain `claude` / `claude -c` invocations do not, and their bridge plugin self-exits before claiming the daemon's single Claude slot. Set to `1` manually only if you want a non-`abg` Claude session to attach to the bridge. |
| `AGENTBRIDGE_SETTINGS_PATH` | `~/.claude/settings.json` | Path to the Claude Code settings file that `wireStatusLine` patches. Tests and headless harnesses set this to redirect off the real settings. |
| `AGENTBRIDGE_LOG_MAX_BYTES` | `50_000_000` | Per-file size cap for `agentbridge.log` before rotation kicks in. Values below 1 KiB fall back to the default. |
| `AGENTBRIDGE_LOG_MAX_FILES` | `3` | How many rotated `agentbridge.log.N` generations to retain. |
| `AGENTBRIDGE_PIN_CONTRACT` | `off` | When `once` (the legacy mid-state) or `always`, the daemon re-appends the BRIDGE_CONTRACT_REMINDER to every Claude→Codex turn. Default `off` because `abg init` writes the same content into `AGENTS.md` so it lives in Codex's system prompt and survives `/compact`. |
| `AGENTBRIDGE_AUTO_SETUP` | unset (enabled) | Set to `0`, `false`, or `no` to suppress the [first-run setup prompt](#first-run-setup). The prompt is already skipped in any non-interactive shell. |

### State Directory

The daemon stores runtime state in a platform-aware base directory:

| Platform | Default Base Path |
|----------|-------------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/` (fallback: `~/.local/state/agentbridge/`) |

Inside a project (a `.agentbridge/` marker was found), state nests one level deeper under the project id — `<base>/<projectId>/` — so projects never share a pid file, log, or kill sentinel. Without a marker, state lives directly in the base directory. An explicit `AGENTBRIDGE_STATE_DIR` is used verbatim and is **not** nested.

Contents of the resolved directory: `daemon.pid`, `status.json`, `agentbridge.log`, `killed` (sentinel), `startup.lock`

### Disabled Bridge States

The bridge can enter several dormant states when it cannot accept new MCP replies. Each state surfaces to the agent as an error message (and, for the transient ones, an in-band push notification):

| State | Cause | Recovery |
|-------|-------|----------|
| `killed` | `abg kill` was run, sentinel file present. | Restart Claude Code (`abg claude`), switch to a new conversation, or run `/resume`. |
| `rejected` | Daemon rejected the connection: another Claude session is already attached. | Close the other session, or run `abg kill` to reset, then `abg claude` again. |
| `evicted` | A newer session evicted this one after the incumbent failed a liveness probe (issue #68). | Close this session and start a fresh one with `abg claude`. |
| `probe_in_progress` | A liveness probe is currently checking the incumbent — contention window. Transient (auto-recovers within `DISABLED_RECOVERY_INTERVAL_MS` × cap, ~30 s). | None needed; the recovery poller reconnects automatically when the slot clears. |
| `auto_recovery_exhausted` | The auto-recovery poller for `probe_in_progress` ran its full retry budget (6 attempts, ~30 s) without succeeding. Terminal. | Retry manually with `abg claude`. |

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- One Codex thread per project; no multiple concurrent threads within a single project
- One Claude foreground connection per project; a new Claude session evicts the previous one after a liveness probe
- Port slots are `projectId mod 1000`, so two projects can collide once you have enough of them on one machine — nothing detects or reassigns the collision today
- Agent roles and the collaboration prompt are hardcoded in `src/collaboration-content.ts`; there is no per-project role customization yet

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
