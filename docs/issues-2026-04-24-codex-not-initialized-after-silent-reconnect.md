# Codex TUI silent crash (third path) — stale session after an unintentional reconnect triggers "Not initialized"

> Date: 2026-04-24
> Status: analysis complete, phase 2 fix pending
> Author: Claude (live diagnosis) / asking Codex to review the conclusion and the fix
> Related commit: `f8698b8` on branch `fix/codex-exit-diagnostics`
> Related logs:
> - `~/Library/Application Support/AgentBridge/codex-wrapper.log`
> - `~/Library/Application Support/AgentBridge/agentbridge.log`

## TL;DR

The wrapper + adapter logging added last round in `f8698b8` **caught a previously uncovered root cause on its very first live reproduction**.

It is **not** FatalExitRequest (scenarios A/B from Codex's earlier PTY experiments).
It is **not** ThreadClosed → ExitMode::Immediate (scenario C).
It **is**: **our own `handleAppServerClose` does not restore `initialize` state on a non-intentional upstream reconnect. The TUI keeps using the stale session, a later request makes the app-server return `"Not initialized"`, the TUI returns `Err` from `main()`, and exits 1.**

## Evidence from the field

### 1. codex-wrapper.log — the TUI-side exit

```
[2026-04-24T11:00:26.116Z] spawn: codex --enable tui_app_server --remote ws://127.0.0.1:4501 --yolo
[2026-04-24T11:00:26.117Z] child pid=62380
[2026-04-24T11:36:31.833Z] exit: code=1 signal=null runtime_ms=2165717 pid=62380 classification=nonzero_exit:1
--- last stderr (377 bytes) ---
Error: turn/steer failed: Not initialized

Stack backtrace:
   0: __mh_execute_header
   1: __ZN4absl22internal_any_invocable19LocalManagerTrivialENS0_14FunctionToCallEPNS0_15TypeErasedStateES3_
   2-8: __mh_execute_header
--- end stderr ---
```

Key data:
- runtime **36 minutes**
- exit code **1**, no signal
- classification `nonzero_exit:1` (not `fatal_exit`, because the stderr prefix is `Error: turn/steer failed`, not `ERROR: remote app server`)
- the all-`__mh_execute_header` stack backtrace is normal for a stripped release build with unresolved symbols (`RUST_BACKTRACE=full` does not help)

### 2. agentbridge.log — the upstream reconnect timeline

```
11:00:26.177  Detected initialize — reconnecting app-server for fresh session
11:00:26.178  App-server reconnected for new TUI session — replaying buffered messages
11:00:26.179  TUI → app-server: initialize
11:00:26.179  TUI → app-server: initialized

... 33 minutes of normal use ...

11:33:34.444  App-server connection closed (intentional=false, tuiConnected=true, turnInProgress=true)  ← ⚠️ upstream dropped on its own, mid-turn
11:33:35.446  Reconnected to app-server                                                                  ← reconnected 1 second later
11:33:35.447  App-server reconnect successful

...           the TUI knows nothing about this and keeps working on the stale session for 3 minutes ...

11:36:31.806  TUI → app-server: turn/steer                                                               ← user presses ESC to cancel the turn
11:36:31.811  TUI disconnected (appServerOpen=true, turnInProgress=false, ...)                           ← TUI dies within 5ms
```

Key fields:
- `intentional=false` → we did not trigger this reconnect; upstream dropped on its own
- `turnInProgress=true` → it dropped while a turn was still being processed
- `appServerOpen=true` (when the TUI died) → proves the cause was not "upstream dropped again" but the TUI exiting on its own
- 3-minute gap → rules out the "dies immediately" path

## Why Codex's earlier PTY experiments never hit this

Codex's three scenarios:
- A: `server close 1000` → immediate FatalExit (stderr: `ERROR: remote app server ... disconnected: connection closed`)
- B: `server close 1011` → same as A, different reason
- C: `thread/closed` notification → immediate ExitMode::Immediate, empty stderr

**Not tested:** "server close → we reconnect immediately → TUI keeps using the session for several minutes → TUI sends a request → app-server returns an error → TUI exits."

That chain depends on **the TUI believing the session is alive while the app-server is actually a brand-new uninitialized one**, so it needs a time gap to reproduce. The PTY experiments cut and closed in one shot, so they never produced it.

## Root cause — in our own code

`src/codex-adapter.ts`:

```
handleAppServerClose()          ← fires when upstream drops non-intentionally
  ├─ this.appServerWs = null
  ├─ clearResponseTrackingState()
  └─ scheduleReconnect()        ← exponential-backoff reconnect
       └─ connectToAppServer(true)
            └─ onopen: this.appServerWs = appWs  ← installs the new socket directly, no initialize replay
```

Compare with the intentional reconnect (triggered by the TUI sending `initialize`):

```
reconnectAppServerForNewSession(tuiWs)
  ├─ buffer TUI messages
  ├─ close the old appServerWs
  ├─ connectToAppServer(false)
  └─ replay buffered messages   ← this re-sends initialize + initialized
```

**The difference:** the intentional reconnect has a replay mechanism; the non-intentional one does not.
The new app-server session is uninitialized, so any request requiring initialized state returns `{error: "Not initialized"}`, which the TUI treats as fatal and exits 1.

## Why `outageQueue` (the phase 1 fix) cannot save this

`outageQueue` only buffers **messages the TUI sends during an outage**. The event sequence here:

1. 11:33:34 upstream close
2. 11:33:35 we reconnect (1 second, faster than the 5-second timeout)
3. during that 1 second the TUI **sends nothing** → the queue is empty
4. by the time the TUI sends `turn/steer` 3 minutes later, `appServerWs` is already OPEN, so it takes the forward branch
5. forwarded to the new session → new session says "Not initialized" → TUI dies

**`outageQueue` protects against "TUI messages get lost". It does not protect against "session state gets lost". Two different failure modes.**

## Phase 2 fix: cache + replay initialize (the user picked option A)

### A.1 Capture stage

In `onTuiMessage`, **before id-rewriting**, recognize and cache:
- the raw JSON of the `initialize` request (including params)
- the raw JSON of the `initialized` notification
- the current `thread/start` or `thread/resume` threadId (we already have the `this.threadId` field)

Stored on new fields, e.g.:
```typescript
private lastInitializeRaw: string | null = null;
private lastInitializedRaw: string | null = null;
// this.threadId already exists
```

### A.2 Replay stage

After `scheduleReconnect` succeeds and `onopen` fires (the non-intentional reconnect path), automatically:

1. If `lastInitializeRaw` exists, send it to the new app-server
   - use a fresh proxy id — remember to rewrite
   - wait for the response before continuing (needs an awaitable send helper, or an id-keyed hook)
2. If `lastInitializedRaw` exists, send it (a notification, no response to await)
3. If `this.threadId` exists, send `thread/resume {threadId}`
4. All succeed → keep serving the TUI as usual; the TUI notices nothing
5. Any step fails → fall back to option B (close the TUI with 1011, let codex-rs FatalExit, user restarts)

Pseudocode:
```typescript
private async restoreSessionAfterUnintentionalReconnect() {
  if (!this.lastInitializeRaw) return true; // nothing to replay

  try {
    await this.sendAndAwait(this.lastInitializeRaw, "initialize");
    if (this.lastInitializedRaw) this.appServerWs.send(this.lastInitializedRaw);
    if (this.threadId) {
      await this.sendAndAwait(JSON.stringify({
        jsonrpc: "2.0",
        id: ...,
        method: "thread/resume",
        params: { threadId: this.threadId },
      }), "thread/resume");
    }
    this.log(`DIAGNOSTIC: session restored after unintentional reconnect (threadId=${this.threadId})`);
    return true;
  } catch (e) {
    this.log(`ERROR: session restore failed: ${e.message} — closing TUI 1011`);
    this.tuiWs?.close(1011, "agentbridge: session restore failed after app-server reconnect");
    return false;
  }
}
```

Hooked into `connectToAppServer`'s `onopen`, firing only when `isReconnect === true` (skipping the first connection).

### A.3 Edge cases

- **TUI has not sent `initialize` yet** → nothing cached → the reconnect takes the old path (probably fine; the TUI may still initialize on its own later)
- **app-server explicitly rejects the replayed `initialize`** (schema mismatch, seq validation, etc.) → fall back to closing the TUI with 1011
- **TUI sends new messages during replay** → reuse the existing `pendingTuiMessages` + `reconnectingForNewSession` machinery: buffer, then flush
- **`this.threadId` is null but `initialize` was sent** (TUI has not entered a thread) → replay `initialize` + `initialized` only, no `thread/resume`
- **Interaction between `clearResponseTrackingState` and the cache**: replayed messages must not be affected by `clearResponseTrackingState` — the cache fields have to survive independently

### A.4 Risks (need Codex to confirm from the codex-rs source)

**Please have Codex check these next session:**

1. **How the `initialize` handler behaves on a repeat call**
   - if idempotent, replay is safe
   - if it errors (e.g. "already initialized"), replay must close-then-open first
2. **Whether `thread/resume` works directly on a fresh session**
   - or whether it requires a fresh `initialize` first
   - or whether it needs additional `thread/attach` / `session/attach` semantics
3. **Whether `initialize`'s params contain session-unique fields**
   - e.g. client nonce, challenge token, timestamp validation
   - if so, a straight replay will be rejected by the app-server
4. **Whether the TUI issues other "session bootstrap" requests besides `initialize` at startup**
   - e.g. `account/read`, `skills/list` (we have seen these in the logs)
   - whether those are idempotent or session-dependent decides whether they need replaying too

**If the codex-rs source shows `initialize` is not replayable**, option A is off the table and we fall back to option B (close the TUI with 1011 so the user sees the disconnect).

### A.5 Test strategy

- Unit: build a mock app-server, complete a normal handshake, close it deliberately, accept a new connection, and assert the adapter automatically sent `initialize` + (optionally) `thread/resume`
- Integration: simulate a 1-second upstream outage and confirm `codex-wrapper.log` records no crash and the TUI stays usable
- E2E: actually run `abg codex`, manually kill the daemon's app-server connection (needs a test port or SIGUSR1), and check the TUI keeps working transparently

## The classification regex should be extended to match

The current heuristic classification in `src/cli/codex.ts`:
```typescript
if (/ERROR: remote app server/.test(tail)) classification = "fatal_exit";
else if (signal) classification = `signal:${signal}`;
else if (typeof code === "number" && code !== 0) classification = `nonzero_exit:${code}`;
else if (code === 0 && tail.trim().length === 0) classification = "exit_0_empty_stderr";
```

**New rules** (Claude will add these alongside phase 2):
```typescript
else if (/Error: .* failed: Not initialized/.test(tail)) classification = "not_initialized_after_reconnect";
else if (/Error: .* failed:/.test(tail)) classification = "rpc_error_exit";
```

That way, the next time a similar crash happens, the wrapper log's classification field says directly whether it is this bug or something like it.

## Current status

- `f8698b8` is pushed to `fix/codex-exit-diagnostics` (remote)
- Phase 1 (diagnostic infrastructure) worked as intended — this crash was **fully on record** and reviewable
- Phase 2 (replay initialize) is Claude's work this round; Codex should review this document before starting
- The user has not opened a PR yet — waiting until this bug is fixed too

## Explicit question list for Codex

1. Do you agree that the real root cause is "the non-intentional reconnect does not replay `initialize`"? Is there a simpler explanation we missed?
2. For the four risks in A.4, what do the codex-rs sources say?
3. If A is not viable, is falling back to B (close the TUI immediately, force a restart) acceptable to users? Or should we do C (replay first, fall back to B only on failure)?
4. Should A's `sendAndAwait` helper be extracted as a shared utility so other replay scenarios can use it?
