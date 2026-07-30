# One frontend slot per agent — E2E Test Plan

## feat: key frontend slots by agent identity instead of a single `attachedClaude`

Related:
- `docs/scaling-plan.md` §4.1b — Grok already loads our MCP server
- `src/frontend-registry.ts` — the extracted bookkeeping
- Supersedes nothing; extends the admission rules from `issue-68-stale-frontend.md`

The bug this prevents: Grok Build reads Claude Code's plugin registry, so it
loads and launches AgentBridge's own MCP server. That frontend attached over the
same control socket Claude uses and landed in the same single `attachedClaude`
variable — so whichever agent connected second was told *"another Claude session
is already connected"* and refused, with nothing in the message hinting that the
two sessions were different agents at all.

The change: one slot per agent identity. `claude_connect` now carries an
optional `agent` field (absent means Claude, so every pre-0.8 frontend is
unchanged); contention, liveness probes, and message buffers are all per-agent;
`DaemonStatus` reports `attachedAgents` alongside the retained `claudeAttached`.

Codex-facing notices stay keyed to Claude on purpose — they name Claude in their
copy, and Codex's role text was written about Claude. Announcing a second agent
under that wording is a product decision, not part of this change.

### Test 1 — single-agent flow unchanged

**Goal:** the common case behaves byte-identically to before the change.

1. Terminal A: `abg claude` — verify `✅ AgentBridge bridge is ready`.
2. Terminal B: `abg codex`.
3. Exchange a message round-trip in both directions.
4. `abg status` shows the bridge attached.

**Pass:** no behavior change; `agentbridge.log` shows `claude frontend attached (#N)`.

### Test 2 — two agents attach at once

**Goal:** the regression this change exists for.

1. Terminal A: `abg claude`, wait for ready.
2. Terminal B: launch a second frontend declaring itself Grok — either the Grok
   TUI once its MCP entry carries `AGENTBRIDGE_AGENT=grok`, or by hand:
   `AGENTBRIDGE_ACTIVE=1 AGENTBRIDGE_AGENT=grok bun run src/bridge.ts`.
3. `curl -s http://127.0.0.1:<control port>/healthz | jq .attachedAgents`.

**Pass:** `["claude","grok"]`; neither socket was closed; `claudeAttached` is
still `true`. Log shows `claude frontend attached` and `grok frontend attached`
with no contest line between them.

### Test 3 — same-agent contention still rejects

**Goal:** regression guard for PR #57 / Issue #68 admission, now scoped per agent.

1. With Test 2's two frontends running, start a *third* frontend declaring
   `AGENTBRIDGE_AGENT=grok`.
2. Confirm it is refused with close code `4001`.
3. Confirm Claude's session is untouched — no probe, no eviction, no
   `Claude Code went offline` notice reaching Codex.

**Pass:** log shows `grok frontend contest:` then
`Rejecting grok frontend #N — incumbent #M responded to liveness probe`, and no
line mentioning `claude` in between.

### Test 4 — stale eviction is per-agent

**Goal:** Issue #68's fix still works, and does not reach across agents.

1. Attach Claude and Grok as in Test 2.
2. `kill -9` the Grok frontend's process so the OS never surfaces FIN.
3. Start a new Grok frontend within 30 s.

**Pass:** the newcomer attaches within ~`LIVENESS_PROBE_TIMEOUT_MS + 1s`
(`Evicting stale grok frontend #M`), and `attachedAgents` still contains
`claude` throughout — Claude's socket was never probed.

### Test 5 — unknown agent refused

**Goal:** a typo must not silently take Claude's slot.

1. Connect to the control socket and send
   `{"type":"claude_connect","agent":"gpt"}`.

**Pass:** closed with `Unknown frontend agent "gpt" — this daemon serves
claude, grok.` Nothing attaches.

### Test 6 — idle shutdown counts every frontend

**Goal:** the daemon must not shut down under a Grok-only session.

1. Attach Grok only, no Claude, no Codex TUI.
2. Wait past `AGENTBRIDGE_IDLE_SHUTDOWN_MS`.

**Pass:** the daemon stays up. Detach Grok and it schedules shutdown as usual.

### Automated coverage

- Unit: `src/unit-test/frontend-registry.test.ts` — 24 cases over slots,
  per-agent probes, loop prevention, and per-agent buffers with overflow and
  failed-flush requeue.
- E2E: `src/unit-test/e2e-multi-frontend.test.ts` — boots a real daemon and
  covers Tests 1, 2, 3, 5 above plus the "a Grok contest does not disturb
  Claude" case, over the real control socket.
- Regression: `src/unit-test/e2e-reconnect.test.ts` and
  `src/unit-test/daemon-client.test.ts` still green.

Tests 4 and 6 stay manual: both need a hard-killed process or a real timer
window, which the automated suite deliberately does not simulate.
