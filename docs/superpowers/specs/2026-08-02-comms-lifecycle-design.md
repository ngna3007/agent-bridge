# Agent communication lifecycle — design

**Date:** 2026-08-02
**Status:** proposed, awaiting review
**Supersedes:** the routing half of `docs/scaling-plan.md` §P2

---

## 1. Why

AgentBridge routes messages by a rule that was never really a routing rule:

> forward to everyone who is not the sender.

That was correct while the bus had exactly two participants, because "not the
sender" and "the intended recipient" were the same set. Both of those facts
stopped being true. `FrontendAgent` is now `"claude" | "grok"`, and the daemon
holds one frontend slot per agent identity — so "not the sender" can name two
different agents, and the bus has no way to say which one was meant.

Four concrete consequences, all present in `master` today:

**1. `[REPLY]` is lost for any non-Claude frontend.**
`ClaudeAdapter.pushViaChannel` sends `notifications/claude/channel` and falls
back to the pull queue *only if the send throws*. That notification is a Claude
Code extension. A plain MCP host receives it and drops it on the floor —
successfully, with no error. So the fallback never fires, and the message is
gone: never pushed, never queued, never recoverable. Tier 2g
(`src/live-test/tier2g-grok-inbound.ts`, check 7) asserts this as current
behaviour. A Grok frontend is therefore half-duplex — it can send into the bus
and drain untagged output, and the high-priority path is a black hole.

**2. Codex is a hard dependency for any conversation.**
`claude_to_codex` is the only send path, and it terminates at the Codex adapter.
Two frontends attached to the same daemon cannot exchange a single message.
The bus is a star with Codex at the hub, and the hub is not optional.

**3. Fan-out is unpriced.**
With two frontends attached, every untagged Codex message is delivered to both,
so it costs tokens twice. Nothing in the system meters or bounds this, and it
gets linearly worse per agent added.

**4. Message identity lives in a string.**
`[REPLY]` / `[STATUS]` / `[FYI]` are parsed out of the content by
`classifyMessage`, and re-parsed by every consumer that needs to know what a
message is. The protocol carries the text; the meaning is re-derived at each
hop.

None of these are fixable in isolation. (1) looks like a delivery bug but is
caused by push being a *delivery path* rather than a *notification*. (3) looks
like a cost problem but is caused by (2)'s missing destination. They are one
design problem, and this document is that design.

---

## 2. Design principle

> **The queue is the ledger. Push is a wake-up.**

Every message lands in the recipient's queue, unconditionally, before any
attempt is made to notify anyone. Push becomes a signal that delivery has
*already happened* — not the delivery itself.

This single inversion is what makes the rest safe:

- A wake-up transport that fails, or that a host silently ignores, costs
  **latency**. It can no longer cost the **message**.
- New agents become additive. Registering a wake-up transport is the entire
  integration; routing and storage do not change.
- The `[REPLY]` loss disappears as a *consequence* of the ledger rather than as
  a special case patched into the delivery path.

---

## 3. Envelope

```ts
/** Every participant addressable on the bus, whatever its transport. */
export type AgentId = "claude" | "grok" | "codex";

export interface BridgeMessage {
  id: string;
  from: AgentId;

  /**
   * Who this is for.
   *   AgentId — one recipient
   *   "*"     — explicit broadcast
   *   null    — unaddressed; the daemon resolves it (see §5)
   */
  to: AgentId | "*" | null;

  /** Promoted out of the text and into the protocol. */
  kind: "reply" | "status" | "fyi" | "untagged";

  content: string;
  timestamp: number;
}
```

Two renames carry weight:

- `source` → `from`, because it now has a counterpart and the pair should read
  as a pair.
- `MessageSource` → `AgentId`. The old type was `FrontendAgent | "codex"` —
  a union that encoded *how you attach* into the identity of *who you are*.
  Transport and identity are separate concerns now. `FrontendAgent` survives
  unchanged for the frontend-slot bookkeeping in `FrontendRegistry`; it is a
  subset of `AgentId`, not a competing spelling of it.

`kind` is populated once, at ingress, by the same parser that produces it
today. Downstream code reads the field. No consumer re-parses content to
discover what a message is.

---

## 4. Addressing

One syntax, because the two producers have unequal capabilities. Claude and
Grok call an MCP tool. Codex has no tool at all — the bridge intercepts its
ordinary prose output. Any scheme that only a tool-caller can express makes
Codex permanently unable to address anyone.

```
Codex writes:   [REPLY @claude] tests pass, merge it
                [FYI @grok] rebased onto master
                [REPLY] looks good              ← unaddressed, resolved per §5

Claude calls:   reply({ to: "grok", content: "..." })
On the wire:    [REPLY @grok] ...
```

The tool's `to` parameter and Codex's prose converge on the same wire format
before parsing, so there is exactly one place that decides what a message means.

```ts
const MARKER_REGEX =
  /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)(?:\s+@([a-z][a-z0-9_-]*))?\]\s*/i;
```

Three rules:

**Only inside the marker.** A bare `@grok` in prose is not an address. Quoting a
filename, discussing another agent, or pasting a diff must never route a
message. Restricting the syntax to the marker makes accidental addressing
impossible rather than merely unlikely.

**An unknown `@name` is a parse failure, not a broadcast.** `[REPLY @grrok]`
is rejected and the sender is told. Silently broadcasting a typo'd address is
precisely the failure class this design exists to remove — it would reintroduce
lossy, invisible routing through the front door.

**`[IMPORTANT]` keeps working.** Existing role files spell it that way, and
`parseMarker` already maps it to `reply`. Unchanged.

---

## 5. Default route — reply-to

```
lastAddressedBy: Map<AgentId, AgentId>
```

When `A` sends an addressed message to `B`, record `lastAddressedBy[B] = A`.
When `B` later sends an *unaddressed* message, route it to `lastAddressedBy[B]`.

```
claude → [REPLY @codex] review this plan
           lastAddressedBy[codex] = claude

codex  → [REPLY] looks fine, one nit          ← unaddressed
           → claude only. grok pays nothing.
```

**Cold start:** if nobody has addressed `B` yet, an unaddressed message from `B`
broadcasts to every attached agent. That is exactly today's behaviour — so a
single-frontend project sees no change at all. Broadcast stops being the only
rule and becomes the bootstrap case.

**Why not require explicit addressing?** It would break every existing role file
and every live session until rewritten, to solve a problem that a conversational
default solves for free. Two agents talking to each other should not have to
re-address every turn.

**Lifetime.** `lastAddressedBy` is daemon-lifetime, in-memory, not persisted.
A daemon restart falls back to the cold-start broadcast, which is safe by
construction. Persisting it would add a migration and a stale-state failure
mode to buy nothing.

---

## 6. Delivery lifecycle

```
inbound message
      │
      ▼
┌─────────────────────────────────────────────┐
│ 1. resolve recipients                       │
│      to = AgentId  → [that agent]           │
│      to = "*"      → all known, minus from  │
│      to = null     → lastAddressedBy, else  │
│                      broadcast              │
└─────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────┐
│ 2. append to each recipient's queue         │  ← THE LEDGER
│    unconditional. attached or not.          │     never skipped
└─────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────┐
│ 3. fire a wake-up, if that agent has one    │
│      claude → notifications/claude/channel  │
│      codex  → turn/start injection          │
│      grok   → leader socket (future)        │
│      none   → nothing. see step 2.          │
└─────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────┐
│ 4. get_messages drains queue, dedupes by id │
└─────────────────────────────────────────────┘
```

**Step 2 is the invariant.** It runs before step 3, never conditionally on it,
and never as a fallback from it. Everything else in this document is
negotiable; this ordering is not.

**Step 3 is best-effort by definition.** A wake-up that throws, times out, or is
silently ignored is logged and dropped. The message is already durable. This is
what converts today's silent permanent loss into at-worst added latency.

**Step 4 dedupes by `id`**, which is what makes it safe for a message to be both
pushed and queued. A Claude session that received a push and then calls
`get_messages` does not see the message twice.

**`kind` still governs step 3, not step 2.** Today's filter semantics survive as
*wake-up policy*: `reply` fires a wake-up, `status` folds into the `StatusBuffer`
summary, `fyi` fires none. The difference is that `status` and `fyi` are now
*queued anyway* — an agent that wants them can call `get_messages` and get them,
instead of them being dropped where nobody can ever recover them.

---

## 7. Topology

The star collapses. Routing becomes a function of `to`, not of "who is not the
sender".

Codex stays behind the proxy. That is a **transport** difference — turn
injection versus a control socket — not a **topology** one. On the bus it is
one more address. Two frontends can then hold a conversation with no Codex
process running at all.

```
before                        after

  claude                        claude ─┐
     │                                  │
   codex  (hub, required)      codex ───┼─── bus (routes by `to`)
     │                                  │
   grok                          grok ─┘
```

---

## 8. What this unlocks

A Grok **backend** adapter becomes purely additive: register `grok` as a third
wake-up transport in step 3, pointing at the leader socket
(`$GROK_HOME/leader.sock`), discovering sessions via `session/list` — which
stabilised in grok 0.2.118 and now advertises
`agentCapabilities.sessionCapabilities.list`, returning sessions with cwd,
branch, and repo facets. (This retires `docs/scaling-plan.md` §4.1a constraint
#2, "discovery is a file, not a method"; `active_sessions.json` is obsolete for
attach and was observed empty even where sessions existed.)

No routing change, no envelope change, no queue change. **That is the test of
whether this design is right** — if adding the adapter requires touching §6,
the design is wrong.

Note that `x.ai/interject` still returns `-32601`, so mid-turn steering remains
unavailable. A Grok adapter must serialise at turn boundaries, exactly as the
Codex `ReplyOutbox` already does.

---

## 9. Migration

The wire format changes. A 0.7 frontend against a 0.8 daemon must not silently
drop messages — silent cross-version loss is the same failure class this whole
document is removing, and shipping it in the fix would be self-defeating.

**Accept both spellings for one minor version.**

- Daemon reading an inbound message: `from ?? source`, `to ?? null`,
  `kind ?? parseMarker(content).marker`. A 0.7 frontend sends `source` only,
  which resolves to an unaddressed message and therefore to §5's cold-start
  broadcast — today's exact behaviour.
- Daemon writing outbound: emit **both** `from` and `source` through 0.8.
  A 0.7 frontend reads `source` and is unaffected. Drop `source` in 0.9.
- `claude_connect` already carries a `projectId` and an `agent`. Add a
  `protocolVersion`, so the daemon can log a version skew instead of inferring
  it from which fields are missing.

Compatibility is asymmetric on purpose: an old frontend against a new daemon
must keep working (users upgrade the daemon via `abg`, and their editor sessions
lag). A new frontend against an old daemon is a `abg kill` away from resolution
and gets a clear message rather than a compatibility shim.

---

## 10. Risks

**Queue growth.** The ledger accumulates messages for an agent that never
attaches. `FrontendRegistry.buffer` already caps at
`AGENTBRIDGE_MAX_BUFFERED_MESSAGES` (default 100) and drops oldest-first. That
cap now governs **correctness**, not just memory: dropping is now the only way a
message can be lost. It must be logged loudly, surfaced in `abg status`, and
reported to the recipient as a gap marker on the next `get_messages` — a silent
drop would reintroduce exactly the bug being fixed, one layer down.

**`requireReply` semantics.** Today any `[REPLY]` satisfies a pending
`requireReply`. With addressing, a `[REPLY @grok]` would wrongly satisfy a
request that Claude is waiting on. The satisfaction check must require a reply
whose resolved recipient **is the asker**.

**`lastAddressedBy` staleness.** If Claude addresses Codex, then Grok addresses
Codex, an unaddressed Codex message goes to Grok — possibly surprising Claude.
Accepted: it matches how a human reads a conversation, and the sender can always
address explicitly. Worth surfacing in `abg status` as "codex is replying to:
grok" so it is inspectable rather than mysterious.

**Broadcast is still reachable.** `to: "*"` and the cold-start path both fan
out, so §1's cost problem is *bounded*, not eliminated. That is deliberate — the
fix is the reply-to default making broadcast rare, not removing the ability to
broadcast.

---

## 11. Out of scope

- **CLI grok-awareness.** `abg doctor` / `init` / `kill` / `roles` still assume
  exactly `claude + codex` (`ROLE_AGENTS = ["claude", "codex"]`; `grep -c grok`
  is 0 in all four). Its own spec and PR, so this one stays reviewable.
- **The Grok backend adapter itself.** §8 shows it drops in; building it is
  separate work, and it is currently blocked on an exhausted xAI balance for
  live testing.
- **Threading, delivery receipts, subscription filters.** Deliberately cut. No
  current failure needs them, and each adds protocol surface that would have to
  be migrated again later.

---

## 12. Test plan

| Level | Proves |
|---|---|
| unit | `MARKER_REGEX` extracts `@agent`; a bare `@agent` in prose does not address; unknown `@name` fails rather than broadcasts; `[IMPORTANT]` still maps to `reply` |
| unit | recipient resolution: explicit / `"*"` / reply-to / cold-start broadcast |
| unit | `lastAddressedBy` updates on addressed sends only, never on broadcast |
| unit | `get_messages` dedupes a message that was both pushed and queued |
| unit | migration: a `source`-only inbound message resolves to a cold-start broadcast |
| e2e | a wake-up that throws still leaves the message drainable via `get_messages` |
| e2e | `requireReply` is **not** satisfied by a reply addressed elsewhere |
| Tier 2g | **check 7 inverts.** A `[REPLY]` to a non-Claude frontend is now in the queue. The characterization test becomes the regression test. |

That last row is the acceptance criterion for the whole document. Tier 2g
currently asserts the bug; when this lands, it asserts the fix.
