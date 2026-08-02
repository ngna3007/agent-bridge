# Agent communication lifecycle — design

**Date:** 2026-08-02
**Status:** proposed — revision 2, incorporating Codex review
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

Six concrete consequences, all verified on `master`:

**1. `[REPLY]` is lost for any non-Claude frontend.**
`ClaudeAdapter.pushViaChannel` sends `notifications/claude/channel` and falls
back to the pull queue *only if the send throws*. That notification is a Claude
Code extension. A plain MCP host receives it and drops it on the floor —
successfully, with no error. So the fallback never fires, and the message is
gone: never pushed, never queued, never recoverable. Tier 2g
(`src/live-test/tier2g-grok-inbound.ts`, check 7) asserts this as current
behaviour.

**2. Codex is a hard dependency for any conversation.**
`claude_to_codex` is the only send path, and it terminates at the Codex adapter.
Two frontends attached to the same daemon cannot exchange a single message.

**3. There are already two queues, and neither is authoritative.**
The daemon buffers for detached frontends in `FrontendRegistry.buffers`; the
frontend adapter keeps its *own* pull queue in `ClaudeAdapter.pendingMessages`
(`claude-adapter.ts:129`). A message hands off between them over a WebSocket
send, and a successful send proves the socket accepted bytes — not that any
agent took custody, and certainly not that one consumed it. "The queue" is not
a thing that exists today.

**4. Codex has no mailbox at all.**
`deliverToCodex` (`daemon.ts:517`, and again from the outbox at `:635`) injects
a turn directly. It never touches `FrontendRegistry`. Codex is a recipient that
the storage layer does not know about.

**5. Fan-out is unpriced.**
Two frontends attached → every untagged Codex message is delivered to both, so
it costs tokens twice. Nothing meters or bounds this.

**6. Message identity lives in a string, and system notices impersonate Codex.**
`[REPLY]`/`[STATUS]`/`[FYI]` are re-parsed from content at each hop. Worse,
daemon lifecycle notices are emitted as `source: "codex"` (`daemon.ts:1102`,
`:1122`) — the daemon speaking in Codex's name.

None of these are fixable in isolation. (1) looks like a delivery bug but is
caused by push being a *delivery path* rather than a *notification*. (5) looks
like a cost problem but is caused by (2)'s missing destination. (3) and (4)
mean there is no single place a fix could even live. They are one design
problem, and this document is that design.

---

## 2. Design principle

> **One mailbox per recipient, owned by the daemon. Push is a wake-up.**

Revision 1 said "the queue is the ledger". Codex's review showed that phrasing
hid the actual problem: there is no *the* queue. Two half-ledgers exist, Codex
has neither, and custody transfers on a socket write. Naming a ledger without
naming its owner is not a design.

So the principle is ownership first:

- The **daemon** owns one authoritative mailbox per recipient — including Codex.
- Every message is enqueued into every resolved recipient's mailbox **before**
  any notification is attempted.
- Push becomes a signal that delivery has *already happened*.
- A message leaves a mailbox only on **acknowledged consumption**, never on a
  successful send.

Consequences:

- A wake-up that fails, or that a host silently ignores, costs **latency**. It
  can no longer cost the **message**.
- New agents become additive. Registering a wake-up transport is the entire
  integration.
- The `[REPLY]` loss disappears as a *consequence* of the model rather than as
  a special case patched into the delivery path.

### Honest scope of "authoritative"

Mailboxes are **in-memory and daemon-lifetime**. A daemon restart loses them.
Revision 1 called this durable; that was wrong. What the model actually
guarantees is: *no message is lost while the daemon lives, and no loss is ever
silent.* Disk persistence is out of scope (§12) — the overflow contract in §8
makes loss visible at send time instead, which solves the failure this document
exists to fix without adding a storage format to migrate.

---

## 3. Envelope

```ts
/** Every participant addressable on the bus, whatever its transport. */
export type AgentId = "claude" | "grok" | "codex";

/** Who a message can be attributed to. `system` is the daemon speaking as itself. */
export type Origin = AgentId | "system";

export interface BridgeMessage {
  /** Canonical, assigned by the daemon at ingress. Globally unique. */
  id: string;

  /** The sender's own id, preserved for correlation. Never used for routing. */
  senderRef?: string;

  /**
   * Derived from the authenticated socket, never from the payload. See §10.
   */
  from: Origin;

  /**
   * Who this is for.
   *   AgentId — one recipient
   *   "*"     — explicit broadcast
   *   null    — unaddressed; resolved by `resolveRecipients` (§6)
   */
  to: AgentId | "*" | null;

  /** The message this one answers, when it answers one. Primary routing signal (§6). */
  inReplyTo?: string;

  /** Promoted out of the text and into the protocol. */
  kind: "reply" | "status" | "fyi" | "untagged";

  content: string;
  timestamp: number;
}
```

Renames and additions that carry weight:

- `source` → `from`, because it now has a counterpart.
- `MessageSource` → `AgentId`. The old type was `FrontendAgent | "codex"` — a
  union that encoded *how you attach* into *who you are*. `FrontendAgent`
  survives for frontend-slot bookkeeping; it is a subset of `AgentId`.
- `Origin` adds `"system"`. Daemon lifecycle notices stop impersonating Codex,
  and — critically — **`from: "system"` never participates in routing state**
  (§6). A `[BRIDGE OFFLINE]` notice must not change who Codex replies to.
- `id` is assigned by the daemon. A sender's own id is kept as `senderRef` so
  correlation still works, but two agents cannot collide on the identifier the
  mailbox and dedupe layer key on.
- `inReplyTo` makes routing **causal** rather than stateful. See §6.

---

## 4. Addressing — two ingresses, one meaning

Claude and Grok call an MCP tool. Codex has no tool at all — the bridge
intercepts its ordinary prose. Any scheme only a tool-caller can express makes
Codex permanently unable to address anyone.

Revision 1 handled this by having the tool render `to` into a marker string,
which the parser then re-read. Codex's review is right that this is a lossy
round-trip through a text format for no reason. Corrected:

**Structured ingress (`reply` tool) constructs the envelope directly.**

```ts
reply({ to: "grok", kind: "reply", content: "..." })
// → envelope built in place. Nothing is serialized. Nothing is re-parsed.
```

If the content *also* carries an embedded marker or `@address` that conflicts
with the structured arguments, the call is **rejected** — two sources of truth
for one message's destination is exactly the class of bug this document
removes.

**Prose ingress (Codex output) is parsed, because it must be.**

```
[REPLY @claude] tests pass, merge it
[FYI @grok] rebased onto master
[REPLY] looks good              ← unaddressed, resolved per §6
```

```ts
const MARKER_REGEX =
  /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)(?:\s+@([a-z][a-z0-9_-]*))?\]\s*/i;
```

The parser's only job is to turn prose into the same envelope the tool builds
directly. One envelope shape, two ways in — not one format both sides
round-trip through.

Three rules:

**Only inside the marker.** A bare `@grok` in prose is not an address. Quoting a
filename or pasting a diff must never route a message.

**An unknown `@name` is a parse failure, not a broadcast.** `[REPLY @grrok]` is
rejected and the sender told. Silently broadcasting a typo'd address would
reintroduce lossy invisible routing through the front door.

**`[IMPORTANT]` keeps working.** Existing role files spell it that way.

---

## 5. Ledger ownership

```
┌────────────────────────────────────────────────────┐
│ daemon                                             │
│   mailboxes: Map<AgentId, Message[]>               │
│     claude ──┐                                     │
│     grok   ──┼── authoritative. sole custody.      │
│     codex  ──┘                                     │
└────────────────────────────────────────────────────┘
        │ wake-up (best-effort)      ▲ drain (authoritative)
        ▼                            │
   frontend adapter ─────────────────┘
```

`ClaudeAdapter.pendingMessages` is **deleted**. The adapter stops being a
storage layer and becomes a transport: it forwards a `get_messages` call to the
daemon and returns what the daemon hands back. One mailbox, one owner, one
place a message can be.

Codex gets a mailbox like everyone else. `deliverToCodex` stops being an
ingress and becomes what it always should have been — Codex's *wake-up
transport*, invoked from step 3 of §7 rather than from the message path.
`ReplyOutbox` keeps its job (Codex accepts one turn at a time) but becomes a
property of that transport rather than a parallel queue.

**Consumption is acknowledged, not assumed.** A message leaves a mailbox when
the recipient's drain is confirmed — not when a socket write returns. This is
what makes §7 step 4 sound.

---

## 6. Routing — one resolver

Revision 1 stated the routing rule in two places, and Codex caught that they
disagreed: §5 said cold start broadcasts to *attached* agents, §6 said *known*
agents. Different sets, both load-bearing. That is precisely the
production-defining duplication that must not survive into code.

**There is exactly one routing function.**

```ts
function resolveRecipients(
  envelope: BridgeMessage,
  state: RoutingState,
): AgentId[];
```

Nothing else decides where a message goes. §4 parses, §5 stores, §7 invokes.

Resolution order:

| `to` | resolves to |
|---|---|
| an `AgentId` | that agent |
| `"*"` | every **known** agent except `from` |
| `null` + `inReplyTo` set | the `from` of the message it answers |
| `null`, no `inReplyTo`, sender is mid-turn | that turn's `activeRequester` |
| `null`, nothing else | every **known** agent except `from` |

"Known", uniformly — `FrontendRegistry.knownAgents()` plus Codex. Never
"attached". A detached agent still has a mailbox; that is the entire point of
having one.

### Causal routing beats `lastAddressedBy`

Revision 1 used a `lastAddressedBy: Map<AgentId, AgentId>` last-writer-wins map,
and listed the three-agent case as an accepted risk. Codex is right that it is a
correctness bug, not a caveat:

```
claude → [REPLY @codex] review this      lastAddressedBy[codex] = claude
grok   → [REPLY @codex] also look at X   lastAddressedBy[codex] = grok
codex  → [REPLY] looks fine              → grok.   ← Claude is still waiting.
```

Codex is answering Claude and the map sends it to Grok. Last-writer-wins cannot
express "which conversation is this a reply *to*", because that is a causal
question and the map holds no causality.

**Fix: `inReplyTo`, plus a turn-scoped `activeRequester`.**

- A reply to a specific message routes to that message's sender. Unambiguous,
  concurrency-proof, no shared mutable state.
- Output produced *during* a turn that some agent requested routes to that
  requester, held for the turn's lifetime and discarded at turn end.
- Only genuinely spontaneous output — outside any turn, answering nothing —
  falls through to broadcast.

`lastAddressedBy` is **removed entirely.** It was a stateful approximation of a
causal fact, and the causal fact is available.

**`from: "system"` never updates routing state.** Lifecycle notices and status
summaries are observations about the bus, not turns in a conversation.

---

## 7. Delivery lifecycle

```
inbound (tool call, or intercepted Codex prose)
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ 0. authenticate: `from` := socket identity  (§10)    │
│    assign canonical `id`; keep sender's as senderRef │
└──────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ 1. resolveRecipients(envelope, state)      — §6      │
│    the ONLY routing decision in the system           │
└──────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ 2. enqueue into each recipient's mailbox   — §5      │
│    per-recipient acceptance (§8). unconditional.     │
│    a full mailbox for A must not block B.            │
└──────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ 3. wake each recipient that has a transport          │
│      claude → notifications/claude/channel           │
│      codex  → turn injection (via ReplyOutbox)       │
│      grok   → leader socket (future)                 │
│      none   → nothing. the message is in step 2.     │
└──────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ 4. drain on consumption, acknowledged      — §5      │
└──────────────────────────────────────────────────────┘
```

**Every ingress goes through this path.** Not just frontend→frontend: the
frontend→Codex path (`deliverToCodex`) and daemon-generated system notices too.
Codex's finding #3 was that revision 1 declared step ordering non-negotiable
while leaving `claude_to_codex` bypassing it entirely. A single
`routeMessage()` entry point, with `deliverToCodex` demoted to a step-3
transport, is what makes the ordering true rather than merely asserted.

**Step 3 is best-effort by definition.** A wake-up that throws, times out, or is
silently ignored is logged and dropped. The message is already in the mailbox.

### Wake-up transports declare whether they acknowledge

This is where I **disagree with the review's recommendation** while accepting
its finding.

Codex is right that a successful push proves the transport accepted a
notification, not that an agent consumed a message — so dedupe-by-id cannot be
driven by "we pushed it". Its proposed fix is that wake-ups carry no content and
every agent always pulls.

That is sound, and I think it is the wrong trade. It costs a mandatory
`get_messages` round-trip for *every* message including Claude's, whose inline
`[REPLY]` delivery is the product's main ergonomic advantage. It makes the
common case worse to fix the uncommon one.

Instead, make acknowledgement a **declared property of the transport**:

```ts
interface WakeupTransport {
  /**
   * True only when a successful send is, by the host's contract, delivery
   * into the agent's context. Claude Code's channel notification is (it
   * renders into the conversation — that is what the extension does).
   * A plain MCP host is not: it may drop an unknown notification silently.
   */
  acknowledgesDelivery: boolean;
}
```

- `acknowledgesDelivery: true` (Claude channel) → wake-up carries content, and a
  successful send consumes the message. Today's UX, preserved exactly.
- `acknowledgesDelivery: false` (any unknown host, and Grok until its adapter
  proves otherwise) → the wake-up is a bare signal. The message stays in the
  mailbox until an acknowledged drain.

The default for an unrecognized host is `false`. The `[REPLY]`-loss bug was
precisely a `false` transport being treated as `true`, so the default must fail
in the safe direction.

**Semantics are at-least-once**, and dedupe-by-`id` on drain is what makes that
safe. Exactly-once is not available across a transport that cannot ack.

**`kind` governs step 3 wake-up policy, not step 2 storage.** `reply` wakes;
`status` folds into the `StatusBuffer` summary; `fyi` wakes nobody. The change
from today is that `status` and `fyi` are *stored anyway*, so an agent that
wants them can pull them instead of them being dropped unrecoverably.

**Status is stored once.** Either the raw messages or the generated summary
enters the mailbox — never both, since they are different `id`s and dedupe
cannot collapse them. Decision: **store raw, summarize at wake-up.** The
summary is a presentation of the mailbox, not a second entry in it.

---

## 8. Overflow contract

Revision 1 kept `FrontendRegistry`'s drop-oldest at 100. Codex is right that
this is wrong once the mailbox is authoritative: the sender was told `success`,
and then the message is silently deleted. Same failure class as the bug being
fixed, one layer down.

**Acceptance is per-kind, per-recipient, and decided before success is
returned.**

| `kind` | policy on a full mailbox |
|---|---|
| `reply` | **reject at send.** The sender gets an explicit failure naming the blocked recipient. Never silently dropped — it is the one kind carrying a conversational obligation. |
| `status` | **coalesce** into the existing summary entry. Bounded by construction. |
| `fyi` | **droppable**, with a counter surfaced in `abg status` and as a gap marker on the next drain. |
| `untagged` | drop-oldest, gap-marked on drain. |

**Broadcast acceptance is per-recipient and independent.** A full Grok mailbox
must not fail or block delivery to Claude. A partially-accepted broadcast
reports which recipients rejected it.

**Every drop is visible** — logged, counted in `abg status`, and reported to the
recipient as a gap marker. A silent drop anywhere reintroduces the original bug.

---

## 9. Topology

The star collapses. Routing is a function of `to`/`inReplyTo`, not of "who is
not the sender".

Codex stays behind the proxy. That is a **transport** difference — turn
injection versus a control socket — not a **topology** one. On the bus it is one
more address with one more mailbox. Two frontends can then hold a conversation
with no Codex process running.

```
before                        after

  claude                        claude ─┐
     │                                  │
   codex  (hub, required)      codex ───┼─── bus (resolveRecipients)
     │                                  │
   grok                          grok ─┘
```

---

## 10. Identity and trust

`from` is **derived from the authenticated socket**, never read from the
payload. The daemon already knows who a socket is: `claude_connect` declares an
agent, it is validated by `parseFrontendAgent`, and it is held in
`ws.data.agent`. That is the only acceptable source of attribution.

Today's check is `msg.source !== "claude"` in `bridge.ts:66` — client-side, in
the process that would be doing the spoofing. It is not a check.

Rules:

- The daemon sets `from` from `ws.data.agent`. Codex's ingress is attributed to
  `codex` because of which adapter it arrived through. System notices are
  attributed to `system`.
- If a payload carries `from` or `source` **disagreeing** with the socket
  identity, the message is **rejected and logged** — not silently corrected. A
  mismatch is either a bug or an impersonation attempt, and both deserve to be
  loud.
- `senderRef` is the one sender-supplied identifier that is kept, and it is used
  only for correlating a reply with a request. It never routes.

---

## 11. Migration

The wire format changes. A 0.7 frontend against a 0.8 daemon must not silently
drop messages — silent cross-version loss is the failure class this document
removes, and shipping it in the fix would be self-defeating.

**Negotiate, don't sniff.** `claude_connect` gains a `protocolVersion`. The
daemon keys its compatibility behaviour on the declared version rather than
inferring it from which fields happen to be missing — inference is how a
partially-upgraded Grok frontend sending a legacy `source: "claude"` would get
silently mis-attributed.

- **Old frontend (no `protocolVersion`) + new daemon:** the daemon treats it as
  0.7. It ignores payload `source` for attribution (§10 applies regardless),
  treats the message as unaddressed, and emits **both** `from` and `source` on
  the way out so the old frontend still parses it. `source` is dropped in 0.9.
- **New frontend + old daemon:** the frontend detects the absent version
  handshake **before sending anything** and refuses with a clear message naming
  `abg kill`. It does not degrade silently.

Compatibility is asymmetric on purpose: users upgrade the daemon via `abg` while
editor sessions lag, so old-frontend/new-daemon must keep working. The reverse
is one command from resolved.

---

## 12. What this unlocks

A Grok **backend** adapter becomes purely additive: register `grok` as a
step-3 wake-up transport pointing at the leader socket
(`$GROK_HOME/leader.sock`), discovering sessions via `session/list` — which
stabilised in grok 0.2.118 and now advertises
`agentCapabilities.sessionCapabilities.list`, returning sessions with cwd,
branch, and repo facets. (This retires `docs/scaling-plan.md` §4.1a constraint
#2, "discovery is a file, not a method"; `active_sessions.json` is obsolete for
attach and was observed empty even where sessions existed.)

It declares `acknowledgesDelivery` and nothing else changes. **That is the test
of whether this design is right** — if adding the adapter requires touching §6
or §7, the design is wrong.

`x.ai/interject` still returns `-32601`, so mid-turn steering is unavailable. A
Grok adapter must serialise at turn boundaries, exactly as `ReplyOutbox` does.

---

## 13. Out of scope

- **Disk persistence.** Mailboxes are daemon-lifetime (§2). §8's
  reject-at-send makes overflow visible without a storage format to migrate.
  Revisit if daemon restarts prove to lose real work.
- **CLI grok-awareness.** `abg doctor`/`init`/`kill`/`roles` still assume
  `claude + codex` (`ROLE_AGENTS = ["claude", "codex"]`; `grep -c grok` is 0 in
  all four). Own spec and PR.
- **The Grok backend adapter itself.** §12 shows it drops in. Blocked on an
  exhausted xAI balance for live testing.
- **Threading, delivery receipts, subscription filters.** `inReplyTo` gives
  causal routing without a thread model. No current failure needs the rest.

---

## 14. Follow-on: `requireReply`

Today `replyRequired` is a module-level boolean (`daemon.ts:128`) satisfied by
any `[REPLY]`. With addressing, a `[REPLY @grok]` would wrongly satisfy a
request Claude is waiting on.

It becomes a per-request correlation: a pending request records its requester
and message id, and is satisfied only by a message whose `inReplyTo` names it,
or whose resolved recipient is the requester. This falls out of `inReplyTo`
almost for free, which is part of why §6 chose causal routing.

---

## 15. Test plan

| Level | Proves |
|---|---|
| unit | `resolveRecipients` is the only routing decision — explicit / `"*"` / `inReplyTo` / `activeRequester` / cold-start broadcast, all against the same "known" set |
| unit | `MARKER_REGEX` extracts `@agent`; bare `@agent` in prose does not address; unknown `@name` fails rather than broadcasts; `[IMPORTANT]` → `reply` |
| unit | structured `reply({to})` builds the envelope directly; a conflicting embedded marker is rejected |
| unit | `from: "system"` never mutates routing state |
| unit | per-kind overflow: `reply` rejects at send; `status` coalesces; `fyi` drops with a counter; a full mailbox for A still accepts for B |
| unit | daemon-assigned canonical ids; `senderRef` preserved; two agents cannot collide |
| security | a payload `from` disagreeing with socket identity is rejected, not corrected |
| security | attribution comes from `ws.data.agent`, not the payload, on every ingress |
| e2e | **an enqueue failure prevents the wake-up** — ordering is enforced, not asserted |
| e2e | frontend→Codex goes through the ledger; `deliverToCodex` is reachable only as a step-3 transport |
| e2e | a wake-up that throws still leaves the message drainable |
| e2e | `acknowledgesDelivery: false` + silently-ignored wake-up → exactly one copy on the next pull |
| e2e | concurrent Claude and Grok turns against Codex: each reply routes to its own requester |
| e2e | `requireReply` is not satisfied by a reply addressed elsewhere |
| e2e | daemon restart: mailboxes are empty and the loss is reported, not silent |
| Tier 2g | **check 7 inverts.** A `[REPLY]` to a non-Claude frontend is in the mailbox. The characterization test becomes the regression test. |

That last row is the acceptance criterion for the whole document.

---

## Appendix: review response (revision 1 → 2)

| # | Finding | Disposition |
|---|---|---|
| 1 | Routing rule duplicated (attached vs known) | **Accepted.** §6 is now a single `resolveRecipients`; "known" uniformly. |
| 2 | Ledger ownership undefined | **Accepted**, daemon-owned mailbox. `ClaudeAdapter.pendingMessages` deleted. |
| 3 | Step ordering bypassed by `deliverToCodex` | **Accepted.** Verified at `daemon.ts:517,635`. Single `routeMessage` entry; Codex gets a mailbox. |
| 4 | Dedupe needs acknowledgement | **Finding accepted, recommendation declined.** Content-free wake-ups penalise Claude's inline delivery to fix an unknown-host problem. Replaced with a per-transport `acknowledgesDelivery` flag defaulting to `false`. |
| 5 | `lastAddressedBy` wrong under concurrency | **Accepted.** Removed entirely; replaced with `inReplyTo` + turn-scoped `activeRequester`. |
| 6 | Migration auth hole | **Accepted**, and escalated to its own section (§10). `from` from socket identity; disagreement rejects; version negotiated not sniffed. |
| 7 | `drop-oldest` wrong for accepted replies | **Accepted.** Per-kind contract in §8; per-recipient independent acceptance. Disk persistence still declined (§13) — reject-at-send makes loss visible without a storage format. |
| 8 | System messages impersonate Codex | **Accepted.** Verified at `daemon.ts:1102,1122`. `Origin` gains `"system"`; system never touches routing state. |
| — | Raw status + summary double-count | **Accepted.** Store raw, summarize at wake-up. |
| — | Structured reply should not round-trip through the marker | **Accepted.** §4 rewritten: two ingresses, one envelope. |
| — | Daemon-assigned canonical ids | **Accepted.** `id` + `senderRef`. |
| — | `requireReply` needs correlation | **Accepted**, §14. |
| — | "Durable" inaccurate across restart | **Accepted.** §2 states the real guarantee. |
