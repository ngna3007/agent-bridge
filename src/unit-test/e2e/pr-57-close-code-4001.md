# PR #57 — E2E Test Plan

## fix: single-session admission + approval lifecycle reliability

### Test 1: single-session protection — new connection is rejected

**Goal:** verify that a second Claude Code session is rejected on connect, and that the first session is unaffected.

1. Terminal A: `agentbridge claude` — start the first Claude Code session
2. Terminal B: `agentbridge codex` — start the Codex TUI
3. Confirm terminal A receives `✅ AgentBridge bridge is ready` and the Codex connection notice
4. **Terminal C: `agentbridge claude` — start a second Claude Code session**
5. Verify:
   - Terminal C (the new session) receives `⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected.`
   - Terminal A (the existing session) is **completely unaffected** and keeps working
   - Terminal A can still talk to Codex normally
6. Close terminal C
7. Terminal A still works

**Pass criteria:** the existing session is untouched; the new session is rejected with a clear error message.

### Test 2: a new session can connect after the old one disconnects

**Goal:** verify a new Claude session connects successfully once the first one shuts down cleanly.

1. Terminal A: `agentbridge claude` — start the first Claude Code session
2. Confirm the connection is healthy
3. Close Claude Code in terminal A (Ctrl+C or `/exit`)
4. Terminal B: `agentbridge claude` — start a new Claude Code session
5. Verify: terminal B connects successfully and receives `✅ AgentBridge bridge is ready`

**Pass criteria:** once the old session releases the slot, the new session connects normally.

### Test 3: approval request replay after TUI disconnect

**Goal:** verify a pending approval request is correctly replayed after the TUI disconnects and reconnects.

1. `agentbridge claude` + `agentbridge codex`
2. From Claude, send Codex a task that requires approval (e.g. modifying a file)
3. When Codex raises the approval request (permission prompt), **do not approve it**
4. `Ctrl+C` to kill the Codex TUI
5. Run `agentbridge codex` again
6. Verify: the approval request is **raised again**; approving it lets Codex continue

**Pass criteria:** the approval request replays correctly after TUI reconnect, and Codex resumes once the user approves.

### Test 4: approval state cleanup after app-server disconnect

**Goal:** verify that stale approval state is discarded on app-server disconnect and never flushed into a new connection.

This scenario is hard to reproduce by hand (it needs precise timing) and is covered mainly by unit tests. Observable signals:

1. During normal use, `/tmp/agentbridge.log` must **not** contain `Flushed buffered approval response after app-server reconnect`
2. If an `App-server connection closed` entry appears, an approval-state cleanup record should follow immediately

**Pass criteria:** the unit test `"app-server close discards approval state across reconnects"` passes.

### Test 5: `agentbridge kill` → recovery

**Goal:** verify the error message in the killed state and the recovery path.

1. `agentbridge claude` + `agentbridge codex`
2. `agentbridge kill`
3. Try to send Codex a message from Claude
4. Verify: you receive the `AgentBridge is disabled by agentbridge kill` error
5. Run `agentbridge claude` again and verify normal recovery

**Pass criteria:** the error message after kill is correct, and restarting recovers normal operation.

### Related

- PR: https://github.com/raysonmeng/agent-bridge/pull/57
- Issues: #55 (Phase 1), #39, #58
- Unit tests: `src/unit-test/daemon-client.test.ts`, `src/unit-test/codex-adapter.test.ts`, `src/unit-test/bridge-disabled-state.test.ts`
