# Silent channel block — root cause & fix

> Discovered 2026-05-30 while debugging why `--channels plugin:agentbridge@agentbridge` produced "Channels are not currently available" on a fresh Claude Max install. Affects every user with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` set anywhere Claude Code reads it. Upstream tracking: [anthropics/claude-code#36503](https://github.com/anthropics/claude-code/issues/36503).

## Symptom

You launch Claude Code with the channels flag:

```bash
claude --channels plugin:agentbridge@agentbridge
```

Splash shows:

```
--channels ignored (plugin:agentbridge@agentbridge)
Channels are not currently available
```

The bridge daemon starts fine, `/mcp` shows `agentbridge ✔ connected`, and `reply` (claude → codex) works. But every codex → claude message disappears into the void — the daemon receives the `agentMessage`, calls `notifications/claude/channel`, the call returns success, and the model never sees a thing.

This is **silent message loss**, not a connection error. `get_messages` (pull mode) still works as a manual workaround, so the bug is invisible until you specifically test the push direction.

## Root cause

The "Channels are not currently available" splash and the silent inbound drop are the **same gate**: `isChannelsEnabled()` returns false. That function reads a server-fetched GrowthBook feature flag named `tengu_harbor`. Decompiled from `claude` v2.1.154:

```js
function isChannelsEnabled() {
  return V$("tengu_harbor", false);
}

function V$(name, default_) {
  // ... settings overrides skipped for brevity ...
  if (!Kx()) return default_;                              // ← short-circuits here
  return b$().cachedGrowthBookFeatures?.[name] ?? default_;
}

function Kx() {
  return !xH(process.env.DISABLE_GROWTHBOOK) && qx();
}
function qx()  { return !OI(); }
function OI()  { return IK5() || If() !== null || $_$(); } // various "disabled" checks
```

`Kx()` is the gate. When it returns false, `V$()` exits with the default value **without** reading the on-disk cache — so even if `tengu_harbor: true` is sitting in `~/.claude.json`'s `cachedGrowthBookFeatures` block (because it was fetched successfully at some point in the past), the flag effectively reads false.

`Kx()` returns false when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set (plus a few other paths — `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`, and certain `OI()` modes like sandboxed `--print` runs).

The trap: the env var is read from `process.env` **and** re-injected by Claude Code from `~/.claude/settings.json`'s `env` block at startup. So a shell-level `unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` doesn't stick — Claude re-imports it from the settings file on the next launch.

## Fix

Remove the variable from `~/.claude/settings.json`:

```bash
jq 'del(.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)' ~/.claude/settings.json \
  > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
```

Relaunch Claude Code. Splash should now read:

```
Listening for channel messages from: plugin:agentbridge@agentbridge
Experimental · inbound messages will be pushed into this session, this carries
prompt injection risks. Restart Claude Code without --channels to disable.
```

Confirmed working configurations:
- Claude Code 2.1.154, Claude Max (OAuth), WSL2/Ubuntu — flipped on first retry after edit
- `fakechat` and dev-mode plugins both deliver after the fix

## If the fix doesn't unlock channels

Two further root causes:

### A. Not in the rollout cohort

```bash
jq '.cachedGrowthBookFeatures.tengu_harbor' ~/.claude.json
```

If that returns `null` or `false`, your account has never been bucketed into the `tengu_harbor` rollout — the channels feature is server-side disabled for your tier/region/A-B group. **No client-side edit will help.** Wait for the rollout to expand, or escalate to Anthropic support.

### B. Another `Kx()`-tripping condition

Check that none of these are set anywhere Claude reads (shell, `settings.json` env block, `/etc/environment`, `/etc/profile.d/*`):

- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- `DISABLE_TELEMETRY`
- `DO_NOT_TRACK`
- `DISABLE_GROWTHBOOK`

And confirm you're not in a sandboxed / non-interactive mode that flips `OI()`.

## Implications for this fork

This is a **real bug for AgentBridge users** — the bridge silently loses every codex → claude message when the gate is closed, without any indication that anything is wrong. Pull-mode `get_messages` still works, so the daemon appears healthy; only the push path is dead.

**Fork.UX2 (planned)** should cover this end-to-end:

1. **Detection at bridge startup.** On `bridge.ts` boot, probe `~/.claude/settings.json` and `process.env` for any of the four gating env vars. If present, log a clear warning to stderr and emit a system notification to the user — *before* the first silent drop.
2. **Auto-fallback to pull mode.** When the probe finds the gate is set, set `AGENTBRIDGE_MODE=pull` for the session and tell the user the bridge fell back. Better silent-correct than silent-broken.
3. **Channel-delivery sentinel.** Send a known ping notification at handshake. If the daemon doesn't see Claude react to it within N seconds (via an inbox-drain heartbeat or similar), declare push dead and fall back to pull. Survives the rollout-cohort case that the env-probe can't detect.
4. **`/doctor`-style diagnostic command.** `abg doctor` checks all four env vars + `tengu_harbor` cache value + recent agent-message delivery rate, prints what's wrong with copy-pasteable fixes.

The win: AgentBridge users with this gate closed get a useful warning + a working bridge instead of a daemon that silently eats half their messages.

## Suggested upstream change

`V$()` should fall through to `cachedGrowthBookFeatures` regardless of `Kx()`'s state. The cached payload represents an entitlement already granted at a moment traffic was allowed; gating its read on live-traffic capability creates the silent-disable trap described above. Equivalently: separate "is this feature enabled for this user" (read cache) from "is telemetry currently allowed" (live fetch). Filed in the upstream comment thread on [#36503](https://github.com/anthropics/claude-code/issues/36503).

## References

- Upstream issue: [anthropics/claude-code#36503](https://github.com/anthropics/claude-code/issues/36503)
- Channels reference: [docs.claude.com — Channels reference](https://code.claude.com/docs/en/channels-reference)
- Binary string evidence: `tengu_harbor`, `isChannelsEnabled`, `gateChannelServer`, `Channel notifications skipped`, `Channels are not currently available` (all in `claude` v2.1.154)
- Cache location: `~/.claude.json` → `cachedGrowthBookFeatures.tengu_harbor`
- Settings location: `~/.claude/settings.json` → `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
