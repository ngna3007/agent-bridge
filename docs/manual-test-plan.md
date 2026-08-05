# AgentBridge manual end-to-end test plan

> Step-by-step harness for validating bridge behavior across both directions, marker contract, lifecycle edges, and the silent-channel-block trap. Walk top to bottom. Each step has copy-paste commands, expected output, and a pass/fail line. Stop at the first FAIL and follow the diagnostic hint.

## Prerequisites checklist

Run all four. All must pass before continuing.

```bash
# 1. Bun installed
bun --version           # expect 1.0+

# 2. Codex installed
codex --version         # expect codex-cli 0.130+

# 3. Claude Code installed at v2.1.80+
claude --version        # expect 2.1.80+

# 4. AgentBridge built + linked + plugin in cache
abg --version           # expect agentbridge v0.1.6+
ls ~/.claude/plugins/cache/agentbridge/agentbridge/*/server/bridge-server.js
```

If any fails: see CONTRIBUTING.md install steps. Don't continue.

## Pre-flight: channels gate check (silent-block trap)

The single biggest source of "bridge looks fine but eats messages." See `docs/channels-silent-block.md` for the full root cause.

```bash
# A. Cohort check — confirm your account has tengu_harbor enabled server-side
jq '.cachedGrowthBookFeatures.tengu_harbor' ~/.claude.json
```

| Result | Action |
|---|---|
| `true` | Continue to step B |
| `false` or `null` | Your account isn't in the channels rollout. STOP — channels won't work. Run all tests below in **pull mode** only by exporting `AGENTBRIDGE_MODE=pull` for the bridge-relevant commands. |

```bash
# B. Env-var gate — make sure none of these are blocking
{
  for v in CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY DO_NOT_TRACK DISABLE_GROWTHBOOK; do
    echo "  shell: $v=${!v:-(unset)}"
  done
  echo "  settings.json env block:"
  jq -r '.env // {} | to_entries[] | "    \(.key)=\(.value)"' ~/.claude/settings.json
}
```

All four vars should be `(unset)` in shell AND absent from settings.json. If present, remove via `jq 'del(.env.<VAR>)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json` and restart your terminal.

```bash
# C. Confirm channels actually unlocked
cd /tmp && claude --channels plugin:agentbridge@agentbridge 2>&1 | head -20
# Then immediately exit the Claude TUI (Ctrl+C twice).
```

Expected splash line:
```
Listening for channel messages from: plugin:agentbridge@agentbridge
```

If you see `Channels are not currently available` instead — STOP, go back and fix per `docs/channels-silent-block.md`.

PASS: ___ FAIL: ___

## Phase 1 — Smoke: daemon + MCP wiring

### 1.1 Clean state

```bash
abg kill 2>&1 | head -5
rm -f ~/.local/state/agentbridge/agentbridge.log
rm -f ~/.local/state/agentbridge/killed
pgrep -af 'agentbridge|codex app-server'   # expect: empty
```

### 1.2 Daemon launches via Claude

Open a fresh terminal, run:

```bash
cd ~/agent-bridge
abg claude
```

In the Claude TUI:
1. Watch for splash: `Listening for channel messages from: plugin:agentbridge@agentbridge`
2. Within ~5s, expect channel notification: `✅ AgentBridge bridge is ready. Daemon connected...`
3. Type `/mcp` — `agentbridge` should show `✔ connected · 2 tools`

```bash
# In a second terminal:
pgrep -af 'agentbridge.*daemon'   # expect: one process
cat ~/.local/state/agentbridge/daemon.pid  # expect: matching PID
curl -s localhost:4502/healthz | jq .
```

Healthz should return JSON with `pid`, `proxyUrl: "ws://127.0.0.1:4501"`, `appServerUrl: "ws://127.0.0.1:4500"`, `tuiConnected: false`, `threadId: null`.

PASS: ___ FAIL: ___

If FAIL: tail `~/.local/state/agentbridge/agentbridge.log`. Most common: port 4500/4501/4502 already in use. Run `lsof -i :4500 -i :4501 -i :4502` and kill the stale processes.

## Phase 2 — Codex attach via app-server proxy

### 2.1 Launch codex via abg

Open a third terminal:

```bash
abg codex
```

Expected codex TUI boot. Within ~5s, a thread should be created. Watch the second-terminal `agentbridge.log`:

```bash
tail -F ~/.local/state/agentbridge/agentbridge.log | grep -E 'TUI connected|Codex ready|thread'
```

You should see lines:
```
Codex TUI connected (conn #1)
Codex ready — thread <uuid>
Bridge fully operational
```

In the Claude TUI: kickoff notification appears:
```
🤝 Codex has connected via AgentBridge.
You are now in a multi-agent collaboration session...
```

PASS: ___ FAIL: ___

If kickoff missing in Claude but log shows codex ready: channels listener is registered but notification isn't reaching the model. Re-run pre-flight C; the gate may have closed.

## Phase 3 — Direction A: claude → codex

### 3.1 Send via `reply` tool

In Claude TUI, type:
```
Use the reply tool to send codex this exact message: "ping from claude. respond with [IMPORTANT] pong"
```

Expected sequence:
1. Claude announces tool use, shows `reply` parameters
2. Tool returns `"Reply sent to Codex."`
3. **Codex TUI shows the new turn LIVE** — your message renders in the codex window as if you typed it, with codex's `>` prompt below
4. Codex generates a reply (should contain `[IMPORTANT] pong`)
5. Reply lands back in Claude as a `<channel source="agentbridge"...>` block via push notification
6. Claude reads the channel block and acknowledges

PASS criteria: all 6 happen, no manual `get_messages` call needed.

PASS: ___ FAIL: ___

If FAIL at step 3 (codex shows nothing): daemon log will say `Injection rejected: ...`. Most likely cause = turn-in-progress collision; wait + retry.

If FAIL at step 5 (Claude gets nothing): silent channel block. Verify pre-flight C still passes. The `tengu_harbor` cohort may have flipped off between launch and now.

### 3.2 Block during codex turn

While codex is mid-generation, in Claude type:
```
Use the reply tool to send codex this: "this should be blocked"
```

Expected: `reply` tool returns error `Codex is busy executing a turn. Wait for it to finish before sending another message.`

Wait for codex turn to complete. Retry; should succeed.

PASS: ___ FAIL: ___

## Phase 4 — Direction B: codex → claude (live push)

### 4.1 Codex initiates with `[IMPORTANT]`

In codex TUI, type:
```
Send a message to Claude with this exact text: "[IMPORTANT] codex-initiated test message"
```

Codex generates an `agentMessage` containing the text. Within ~2s, Claude TUI should render an inbound `<channel source="agentbridge" ...>codex-initiated test message</channel>` and Claude should acknowledge.

PASS criteria: Claude renders the message **without** the user typing anything in the Claude window.

PASS: ___ FAIL: ___

If FAIL: this is the silent-channel-block again. Confirm via `/mcp` that agentbridge is still `✔ connected`. If yes, the daemon emitted the notification but channels-feature isn't routing it. Refer to `docs/channels-silent-block.md`.

### 4.2 `[STATUS]` is buffered, not pushed immediately

In codex TUI:
```
Send a [STATUS] message every 2 seconds for 10 seconds.
```

Watch Claude TUI: STATUS messages should NOT each surface immediately. After 10s OR when an `[IMPORTANT]` arrives, the daemon flushes them as a batched summary.

PASS: ___ FAIL: ___

### 4.3 `[FYI]` is dropped

In codex TUI:
```
Send an [FYI] message: "this should be silently dropped"
```

Expected: nothing appears in Claude. Daemon log shows `Codex → Claude [fyi/drop]`.

PASS: ___ FAIL: ___

### 4.4 `require_reply` force-flushes everything

In Claude TUI:
```
Use the reply tool with require_reply=true to ask codex: "respond with anything tagged [STATUS]"
```

Expected: codex's STATUS reply normally would be buffered, but because `require_reply` is set, daemon force-forwards all codex messages for that turn immediately.

PASS: ___ FAIL: ___

## Phase 5 — Lifecycle edges

### 5.1 Codex TUI disconnect

In the codex terminal, Ctrl+C the codex TUI. Wait ~3s. Claude should receive:
```
⚠️ Codex TUI disconnected (conn #1). Codex is still running in the background...
```

PASS: ___ FAIL: ___

### 5.2 Codex reconnect

Restart codex in its terminal:
```bash
abg codex
```

Claude should receive:
```
✅ Codex TUI reconnected (conn #2). Bridge restored...
```

Codex TUI should receive:
```
✅ Claude Code is still online, bridge restored. Bidirectional communication can continue.
```

PASS: ___ FAIL: ___

### 5.3 Claude session swap

Open a **second** Claude session (different terminal):
```bash
cd ~/agent-bridge
abg claude
```

Original Claude session should receive:
```
⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected...
```

OR the original session gets evicted (close code 4002) if the new one waits out the liveness probe.

Close the new Claude. Original Claude should reconnect automatically with `✅ AgentBridge daemon reconnected successfully.`

PASS: ___ FAIL: ___

### 5.4 `abg kill` is sticky

```bash
abg kill
```

Both Claude and codex should receive shutdown notifications. The daemon process should be gone:
```bash
pgrep -af 'agentbridge.*daemon'   # expect: empty
ls ~/.local/state/agentbridge/killed  # expect: file exists
```

Restart Claude in its terminal: `abg claude` — but with the kill sentinel present, the bridge should NOT auto-restart the daemon. Claude receives:
```
⛔ AgentBridge was stopped by `agentbridge kill`. Bridge is staying idle...
```

Clear sentinel + relaunch:
```bash
rm ~/.local/state/agentbridge/killed
# In Claude TUI: type any message, bridge should auto-reconnect within ~30s
```

PASS: ___ FAIL: ___

### 5.5 Daemon crash recovery

Get daemon pid: `cat ~/.local/state/agentbridge/daemon.pid` then:
```bash
kill -9 <pid>
```

Claude should receive within ~2s: `⚠️ AgentBridge daemon control connection lost. Attempting to reconnect...`

`bridge.ts` should retry with exponential backoff and respawn the daemon. Within ~10s: `✅ AgentBridge daemon reconnected successfully.`

PASS: ___ FAIL: ___

## Phase 6 — Codex app-server proxy edge cases

### 6.1 Codex app-server crash

Find the app-server pid:
```bash
pgrep -af 'codex app-server'
```

Kill it: `kill -9 <pid>`. Codex TUI should display an upstream error. Daemon should attempt automatic reconnect to app-server (within ~5s, with outage queue buffering TUI messages).

Watch log:
```bash
tail -F ~/.local/state/agentbridge/agentbridge.log | grep -E 'app-server|outage|reconnect'
```

PASS: ___ FAIL: ___

### 6.2 Session restore after silent reconnect

After codex app-server crashes + comes back, the proxy should replay cached `initialize` / `thread/resume` automatically. Codex TUI shouldn't see any error — just briefly hang then continue.

Type a follow-up message in codex; it should work without `turn/steer failed: Not initialized` error.

PASS: ___ FAIL: ___

## Phase 7 — Stress tests (optional)

### 7.1 Rapid burst from codex

In codex TUI:
```
Send 20 [IMPORTANT] messages back-to-back, each numbered 1 through 20.
```

Expected: all 20 arrive in Claude in order. None dropped.

PASS: ___ FAIL: ___

### 7.2 Bidirectional concurrent

In Claude TUI: send a `reply` to codex asking for a long detailed response.
While codex is generating: in codex TUI, send a `[IMPORTANT]` standalone message.

Expected: codex's eventual response to Claude's request lands. The standalone IMPORTANT message lands separately. No corruption, no lost messages, no `turnInProgress` errors that aren't followed by recovery.

PASS: ___ FAIL: ___

## Phase 8 — Negative tests (verify failure modes are clean)

### 8.1 Bridge with channels gated off

Re-introduce the silent-block:
```bash
jq '.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"' ~/.claude/settings.json \
  > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
abg kill
```

Restart claude + codex. Send a `[IMPORTANT]` from codex. Currently (v0.1.6) Claude sees nothing — bridge silently drops. **This is the bug Fork.UX2 will fix**; document the current broken-by-design behavior.

After confirming the silent drop: restore your settings:
```bash
jq 'del(.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)' ~/.claude/settings.json \
  > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
```

PASS (silent drop reproduced): ___

### 8.2 Codex CLI not installed (skip on a healthy box)

If you can rename codex binary temporarily:
```bash
sudo mv $(which codex) /tmp/codex.backup
abg codex 2>&1 | head -5    # expect clear error, not crash
sudo mv /tmp/codex.backup $(which codex)
```

PASS: ___ FAIL: ___

### 8.3 Port collision

Bind 4501 manually:
```bash
nc -l 4501 &
NC_PID=$!
abg kill && abg claude    # in another terminal
# Expect: daemon refuses to start with clear port-conflict error
kill $NC_PID
```

PASS: ___ FAIL: ___

## Cleanup

```bash
abg kill
rm -f ~/.local/state/agentbridge/killed
rm -f ~/.local/state/agentbridge/daemon.pid
rm -f ~/.local/state/agentbridge/status.json
# Keep agentbridge.log for post-mortem if anything failed
```

## Result summary

| Phase | Result |
|---|---|
| Pre-flight | ___ |
| 1. Smoke | ___ |
| 2. Codex attach | ___ |
| 3. claude → codex | ___ |
| 4. codex → claude (push) | ___ |
| 5. Lifecycle edges | ___ |
| 6. App-server edges | ___ |
| 7. Stress | ___ |
| 8. Negative | ___ |

File issues / PRs for any FAIL with:
- The exact phase number
- The full splash + last 50 lines of `~/.local/state/agentbridge/agentbridge.log`
- Output of `/mcp` from the Claude TUI
- `jq '.cachedGrowthBookFeatures.tengu_harbor' ~/.claude.json`
- Codex version, Claude Code version, OS
