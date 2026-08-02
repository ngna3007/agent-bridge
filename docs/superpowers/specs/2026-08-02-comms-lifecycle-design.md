# Agent communication lifecycle — design

**Date:** 2026-08-02
**Status:** proposed — revision 4, incorporating three rounds of review
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

The same shape has already bitten Claude itself. `docs/channels-silent-block.md`
records a *successful* `notifications/claude/channel` call that the model never
saw, because a server-side `tengu_harbor` flag had the channel gated off. A
send returning success has never been evidence of delivery on this transport —
for any frontend.

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
Revision 1 called this durable; that was wrong. So was "no message is lost" —
§8 deliberately sheds `fyi` and `untagged` under pressure. What the model
actually guarantees is:

> *No accepted `reply` is ever silently lost while the daemon lives, and all
> shedding is visible — to the sender at send time, or to the recipient as a
> gap marker on drain.*

Disk persistence is out of scope (§13) — the overflow contract in §8
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
`ReplyOutbox` keeps its job (Codex accepts one turn at a time) but holds
**mailbox ids only** — never message bodies. A queue of ids cannot become a
second custodian; a queue of messages already did once.

### 5.1 Consumption: leased batches and explicit ack

"Confirmed" needs a wire protocol or it is a wish. Drain is a two-step lease:

```ts
// 1. recipient asks for work. daemon leases, does not delete.
drain(agent) -> { batchId: string, messages: BridgeMessage[] }

// 2. recipient confirms what it actually took.
ack(batchId, ids: string[]) -> void
```

- A lease marks its messages **invisible to further drains** for
  `LEASE_TIMEOUT_MS`, so a second call does not re-serve in-flight work.
- `ack` deletes exactly the ids named. Ids in the batch but absent from the
  ack, and leases that expire unacked, become visible again and are
  **redelivered**.
- A failed or never-returned drain response therefore costs a redelivery, not a
  message.

This is at-least-once by construction. Duplicates are the price of never
losing one, and dedupe-by-`id` at the consumer is what makes that price small.
Exactly-once is not available over a transport that cannot acknowledge, and
claiming it would be the same category of error as revision 1's silent push.

### 5.2 Provenance index

Causal routing (§6) resolves `inReplyTo` by looking up the original message's
`from`. But that message is deleted from its mailbox on ack — often long before
the reply arrives. The mailbox cannot answer the question.

So the daemon keeps a separate, small, append-only index:

```ts
messageIndex: Map<string, { from: Origin; recipients: AgentId[]; at: number }>
```

**Write ordering.** The `id` is assigned at step 0, but `recipients` cannot be
known then — routing happens at step 1 and per-recipient acceptance at step 2
(§8 lets a broadcast be accepted by one mailbox and rejected by another). So the
index entry is written **atomically after the enqueue decisions and before any
wake-up**, containing only the recipients that actually accepted. If no
recipient accepted, no entry is written — there is nothing to reply to.

Other rules:

- Independent of mailbox lifetime; entries outlive the message, not the daemon.
- **Authorization:** `inReplyTo` resolves only if the replier is one of that
  entry's accepted `recipients`. Otherwise the reply is rejected. Without this
  check, any agent could route to any other by guessing an id.
- An entry whose `from` is `"system"` is **not a valid `inReplyTo` target.** The
  resolver returns an `AgentId`, not an `Origin`; system notices are not turns
  in a conversation (§6) and cannot be replied to.
- An `inReplyTo` naming an expired or unknown id is a **parse failure**, not a
  fallthrough to broadcast — same rule, same reason, as an unknown `@name`
  (§4).
- **Retention outlives every reference to it.** The TTL must exceed the mailbox
  lease, the lifetime of an active turn, and any pending `requireReply`
  correlation (§14). An entry that is still referenced is pinned and is never
  evicted merely because the count cap was reached — the cap sheds unpinned
  entries, or it fails loudly. Evicting a referenced entry would turn a valid
  reply into a parse failure, which is silent loss wearing a different hat.

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

### Payload and acknowledgement are independent axes

Revision 2 proposed a single `acknowledgesDelivery: boolean` — content-carrying
pushes would also consume the mailbox entry. That was wrong, and this
repository already contains the disproof.

`docs/channels-silent-block.md` documents the exact failure: with the
`tengu_harbor` gate closed, "the daemon receives the `agentMessage`, calls
`notifications/claude/channel`, **the call returns success, and the model never
sees a thing**." The gate is server-side and per-account; it can also be closed
by an env var Claude Code re-imports from `settings.json`. A capability flag
compiled into the transport cannot see any of that. It describes what the
transport *believes*, and the belief is wrong precisely in the case that
produced the original bug.

MCP notifications are one-way. `await server.notification()` proves bytes were
written. Nothing more is available from it, ever.

So the two questions are separated, because they were always separate
questions:

```ts
interface WakeupTransport {
  /** Does the wake-up carry the message, or only the fact that one exists? */
  payloadMode: "content" | "signal";

  /** Can this transport produce correlated evidence of consumption? */
  acknowledgementMode: "explicit" | "none";
}
```

The Claude Code channel is `{ payloadMode: "content", acknowledgementMode:
"none" }`. Inline `[REPLY]` delivery is preserved exactly — the push still
carries the text, and in the common case the model reads it and acts on it with
no round-trip. What changes is that **the push does not consume the mailbox
entry**. Only an `ack` from §5.1 does.

Be precise about what that costs, because an earlier draft of this paragraph
overstated it. With `acknowledgementMode: "none"` **there is no actor that can
acknowledge a successful inline delivery** — the channel exposes no correlated
receipt, so the daemon cannot distinguish "the model read it" from "the gate ate
it". The message therefore stays in the mailbox and **a working push may be
seen a second time on the next drain.**

The full contract:

1. A push never consumes.
2. A *working* push may duplicate once, on the next drain.
3. A drain `ack` (§5.1) prevents every subsequent redelivery.
4. The canonical `BridgeMessage.id` appears **identically** in the channel
   metadata and in the drained payload, so the consumer can recognise the
   duplicate as one it has already seen.

Rule 4 is what makes rule 2 tolerable, and it is a hard requirement on the push
format rather than a nicety. Loss becomes at-most-one duplicate. That is the
trade this document exists to make.

When the channel is silently gated, the same mechanism means the message is
simply still in the mailbox and `get_messages` returns it — the original bug,
gone.

`{ payloadMode: "signal", acknowledgementMode: "none" }` is the default for an
unrecognised host — a bare wake-up, no content on a channel that may not
deliver it.

**`kind` governs step 3 wake-up policy, not step 2 storage.** `reply` wakes;
`status` wakes only as a coalesced summary; `fyi` wakes nobody. The change from
today is that `status` and `fyi` are *stored anyway*, so an agent that wants
them can pull them instead of them being dropped unrecoverably.

**Status has one representation: raw entries in the mailbox.** The summary sent
at wake-up is rendered from them and is never itself stored — a rendering has
no `id` and no lifecycle. See §8 for what happens when raw status entries
exceed the cap.

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
| `status` | **collapse the oldest raw entries into one gap entry** (`"N status messages elided"`), which is itself a normal mailbox entry with its own id. Bounded, and the representation stays "raw entries" throughout — nothing is stored in two shapes. |
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
- `senderRef` is the one sender-supplied identifier that is kept, and it is used
  only for correlating a reply with a request. It never routes.

### 10.1 Normalization — one function, version-aware

Revision 2 said two different things about a payload whose `source` disagrees
with the socket: §10 rejected it unconditionally, §11 ignored it for legacy
frontends. Both cannot be the rule, and a rule stated twice is how the first
draft's routing bug happened.

**There is exactly one normalization function, and it lives inside
authenticated ingress:**

```ts
function normalizeIngress(
  raw: unknown,
  socket: { agent: Origin; protocolVersion: number | null },
): BridgeMessage;   // throws on rejection
```

Nothing else reads `source`. Nothing else writes `from`. The version is a
parameter, not a second code path:

| declared version | payload `from` / `source` |
|---|---|
| ≥ 1 (current) | must be absent, or equal `socket.agent`. Disagreement → **reject and log.** |
| absent (legacy 0.7) | **ignored entirely.** The field is vestigial in that version, was never authenticated, and cannot be a mismatch signal. |

`from` is set from `socket.agent` in both rows. The difference is only whether
a disagreeing payload field is an error or noise — and that is a property of
what the version *promised*, which is why the version must be declared rather
than inferred.

---

## 11. Migration

The wire format changes. A 0.7 frontend against a 0.8 daemon must not silently
drop messages — silent cross-version loss is the failure class this document
removes, and shipping it in the fix would be self-defeating.

**Negotiate, don't sniff.** `claude_connect` gains a `protocolVersion`, and
§10.1 keys off it. Inferring the version from which fields happen to be present
is how a partially-upgraded frontend sending a legacy `source: "claude"` would
get silently mis-handled.

- **Old frontend (no `protocolVersion`) + new daemon:** normalized by the legacy
  row of §10.1. Treated as unaddressed, and **both** `from` and `source` are
  emitted on the way out so the old frontend still parses it. `source` is
  dropped in 0.9.
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

It declares its `payloadMode` and `acknowledgementMode` and nothing else
changes. **That is the test
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
| unit | per-kind overflow: `reply` rejects at send; `status` collapses to a gap entry; `fyi` drops with a counter; a full mailbox for A still accepts for B |
| unit | daemon-assigned canonical ids; `senderRef` preserved; two agents cannot collide |
| unit | leased drain: a second drain during a live lease returns nothing; an expired lease redelivers; a partial `ack` redelivers only the unacked ids |
| unit | `normalizeIngress` is the only writer of `from` — current version rejects a disagreeing payload, legacy version ignores it, both derive from the socket |
| unit | status overflow produces a gap entry with its own id; no summary is ever stored |
| security | `inReplyTo` naming a message the replier did not receive is rejected |
| security | `inReplyTo` naming an expired or unknown index entry fails rather than broadcasting |
| security | a payload `from` disagreeing with socket identity is rejected, not corrected |
| security | attribution comes from `ws.data.agent`, not the payload, on every ingress |
| e2e | **an enqueue failure prevents the wake-up** — ordering is enforced, not asserted |
| e2e | frontend→Codex goes through the ledger; `deliverToCodex` is reachable only as a step-3 transport |
| e2e | a wake-up that throws still leaves the message drainable |
| e2e | **the `tengu_harbor` case**: a content push that returns success while the model receives nothing → the message is still drainable, and arrives exactly once |
| e2e | a content push that *is* delivered may appear once more on the next drain, carrying the **same** `id` as the push metadata; after the ack it never reappears |
| e2e | the provenance index outlives the acked message: a reply arriving after the original was drained still routes to its sender |
| unit | the index entry is written after acceptance and lists only accepting recipients; a broadcast rejected by every mailbox writes no entry |
| unit | a pinned index entry (live lease, active turn, pending `requireReply`) is not evicted by the count cap |
| security | `inReplyTo` naming a `from: "system"` entry is rejected |
| e2e | concurrent Claude and Grok turns against Codex: each reply routes to its own requester |
| e2e | `requireReply` is not satisfied by a reply addressed elsewhere |
| e2e | daemon restart: mailboxes are empty and the loss is reported, not silent |
| Tier 2g | **check 7 inverts.** A `[REPLY]` to a non-Claude frontend is in the mailbox. The characterization test becomes the regression test. |

That last row is the acceptance criterion for the whole document.

---

## Appendix A: review response (revision 3 → 4)

| Finding | Disposition |
|---|---|
| §7 claimed a delivered push is acked on the next drain and never seen twice — impossible under `acknowledgementMode: "none"` | **Accepted.** No actor can acknowledge an inline delivery. §7 now states the real contract: push never consumes, a working push may duplicate exactly once on the next drain, ack stops all further redelivery, and the canonical `id` must appear identically in channel metadata and drained payload so the consumer can dedupe. |
| §5.2 wrote `recipients` at step 0, before routing (step 1) or acceptance (step 2) | **Accepted.** Id at step 0; the index entry is written atomically after enqueue decisions and before any wake-up, listing only accepting recipients. No acceptance → no entry. |
| `inReplyTo` could target a `system` entry | **Accepted.** The resolver returns `AgentId`, not `Origin`; system entries are not reply targets. |
| Index retention could evict a referenced entry | **Accepted.** TTL exceeds lease, active turn, and pending `requireReply`; referenced entries are pinned and the cap sheds only unpinned ones. |
| §2 claimed no message is lost, while §8 sheds `fyi`/`untagged` | **Accepted.** Restated: no accepted `reply` silently lost, all shedding visible. |

---

## Appendix B: review response (revision 2 → 3)

| Finding | Disposition |
|---|---|
| `acknowledgesDelivery` relocates the trust assumption rather than removing it | **Accepted, and my revision-2 counter-proposal withdrawn.** The disproof is in this repository: `docs/channels-silent-block.md` records a successful `notifications/claude/channel` call that the model never sees, gated by a server-side per-account flag no compiled-in capability can observe. Split into `payloadMode` × `acknowledgementMode` (§7). Claude keeps `content` push; the push no longer consumes. |
| Drain ack has no wire protocol | **Accepted.** §5.1: leased batches, explicit `ack(batchId, ids)`, lease expiry redelivers. |
| `inReplyTo` cannot resolve after the original is drained | **Accepted.** §5.2 adds a daemon-owned `messageIndex` with TTL, plus an authorization check so an id cannot be guessed into a routing capability. |
| §10 and §11 contradict on legacy `source` | **Accepted.** One `normalizeIngress(raw, socket)` inside authenticated ingress, version as a parameter (§10.1). |
| §7 stores raw status, §8 coalesces into a stored summary | **Accepted.** One representation: raw entries. Overflow collapses old ones into a gap entry that is itself an ordinary entry. The wake-up summary is rendered, never stored. |
| `ReplyOutbox` must not duplicate custody | **Accepted.** Mailbox ids only. |

Revision 2's remaining position — no disk persistence — is unchanged and was
not contested.

---

## Appendix C: review response (revision 1 → 2)

| # | Finding | Disposition |
|---|---|---|
| 1 | Routing rule duplicated (attached vs known) | **Accepted.** §6 is now a single `resolveRecipients`; "known" uniformly. |
| 2 | Ledger ownership undefined | **Accepted**, daemon-owned mailbox. `ClaudeAdapter.pendingMessages` deleted. |
| 3 | Step ordering bypassed by `deliverToCodex` | **Accepted.** Verified at `daemon.ts:517,635`. Single `routeMessage` entry; Codex gets a mailbox. |
| 4 | Dedupe needs acknowledgement | Finding accepted; revision 2's counter-proposal (a per-transport `acknowledgesDelivery` flag) was **withdrawn in revision 3** — see Appendix A. |
| 5 | `lastAddressedBy` wrong under concurrency | **Accepted.** Removed entirely; replaced with `inReplyTo` + turn-scoped `activeRequester`. |
| 6 | Migration auth hole | **Accepted**, and escalated to its own section (§10). `from` from socket identity; disagreement rejects; version negotiated not sniffed. |
| 7 | `drop-oldest` wrong for accepted replies | **Accepted.** Per-kind contract in §8; per-recipient independent acceptance. Disk persistence still declined (§13) — reject-at-send makes loss visible without a storage format. |
| 8 | System messages impersonate Codex | **Accepted.** Verified at `daemon.ts:1102,1122`. `Origin` gains `"system"`; system never touches routing state. |
| — | Raw status + summary double-count | **Accepted.** Store raw, summarize at wake-up. |
| — | Structured reply should not round-trip through the marker | **Accepted.** §4 rewritten: two ingresses, one envelope. |
| — | Daemon-assigned canonical ids | **Accepted.** `id` + `senderRef`. |
| — | `requireReply` needs correlation | **Accepted**, §14. |
| — | "Durable" inaccurate across restart | **Accepted.** §2 states the real guarantee. |
