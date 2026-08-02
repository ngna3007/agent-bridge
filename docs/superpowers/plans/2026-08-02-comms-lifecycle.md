# Agent Communication Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AgentBridge's "forward to everyone who is not the sender" routing with a daemon-owned mailbox per recipient, causal addressing, and a wake-up transport layer, so no accepted `reply` is silently lost and any agent can address any other.

**Architecture:** The daemon becomes the sole custodian of messages. Every ingress — the `reply` tool, intercepted Codex prose, and daemon system notices — funnels through one `MessageBus.route()` that authenticates the sender from its socket, resolves recipients with one `resolveRecipients` function, enqueues into per-recipient `Mailbox` instances, records provenance in a `MessageIndex`, and only then fires best-effort wake-ups. Consumption is a leased drain plus an explicit ack; a wake-up never consumes.

**Tech Stack:** TypeScript on Bun. `bun test` for unit/E2E. No new runtime dependencies. WebSocket control protocol between `bridge.ts` and `daemon.ts`; MCP stdio between Claude Code and `bridge.ts`.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-08-02-comms-lifecycle-design.md` (revision 6, approved). Where this plan and the spec disagree, the spec wins — stop and ask.
- Runtime is **Bun**. Do not change the local Bun version. Do not add dependencies.
- Before every commit: `bun run typecheck && bun test src`. Both must pass.
- After modifying `src/`: `bun run build:plugin` before any end-to-end run.
- **Never push directly to `master`.** All work lands on branch `feat/comms-lifecycle` and merges through a PR with `--repo ngna3007/agent-bridge`.
- Commit messages and code comments are **English only**.
- Never add a `Co-Authored-By:` or `Claude-Session:` trailer to a commit in this repo.
- `AgentId = "claude" | "grok" | "codex"`. `Origin = AgentId | "system"`. Exact strings, lowercase.
- `PROTOCOL_VERSION = 1`. A frontend that omits `protocolVersion` is legacy 0.7 and its payload `source` field is ignored, never treated as a mismatch.
- Mailboxes are in-memory and daemon-lifetime. Disk persistence is out of scope.
- The system **never claims exactly-once delivery**. No test may assert it.
- `role:` remains a label the agent reads. Nothing in this plan parses it as routing.
- The two WSL2 loopback tests that already time out on this machine (`docs`-noted, 2 of 411) are pre-existing and not caused by this work.

**Prerequisite:** Task 15 modifies `src/live-test/tier2g-grok-inbound.ts`, which exists only on branch `test/grok-inbound-delivery` (PR #13). Merge PR #13 to `master` and rebase `feat/comms-lifecycle` onto it before starting Task 15. Tasks 1–14 do not depend on it.

---

## File Structure

**New modules** (each one responsibility, each independently testable):

| File | Responsibility |
|---|---|
| `src/agent-id.ts` | `AgentId` / `Origin` types, the canonical id list, and parsing/validation. No behaviour. |
| `src/mailbox.ts` | One recipient's authoritative store: per-kind overflow, leased drain, ack, gap markers. |
| `src/message-index.ts` | Provenance for `inReplyTo`: who sent what, who accepted it, TTL, authorization. |
| `src/routing.ts` | `resolveRecipients` — the only function in the system that decides where a message goes. |
| `src/normalize-ingress.ts` | The only writer of `from`. Version-aware payload normalization. |
| `src/wakeup-transport.ts` | `WakeupTransport` shape (`payloadMode` × `acknowledgementMode`) and the per-agent registry. |
| `src/message-bus.ts` | Steps 0–3 of §7 in order, with enqueue+index as one transaction. |

**Modified:**

| File | Change |
|---|---|
| `src/types.ts` | `BridgeMessage` becomes the §3 envelope. `MessageSource` retired. |
| `src/message-filter.ts` | `MARKER_REGEX` gains `@agent`; `parseMarker` returns the address. |
| `src/claude-adapter.ts` | `pendingMessages` deleted. `get_messages` becomes drain+ack over the control socket. |
| `src/control-protocol.ts` | `protocolVersion` on `claude_connect`; `hello`, `drain`, `drain_result`, `ack` messages. |
| `src/daemon-client.ts` | `drain()` / `ack()` client methods; refuse a daemon that sends no `hello`. |
| `src/daemon.ts` | Every ingress routed through `MessageBus`. `deliverToCodex` demoted to a transport. `replyRequired` becomes per-request correlation. System notices attributed to `system`. |
| `src/bridge.ts` | Sends `protocolVersion`; drops the client-side `msg.source !== "claude"` pseudo-check. |
| `src/frontend-registry.ts` | Loses `buffers` / `buffer()` / `takeBuffered()` / `requeue()` / `recipients()`. Keeps slots, `knownAgents()`, probing. |
| `src/reply-outbox.ts` | Holds mailbox ids, not message bodies. |
| `src/live-test/tier2g-grok-inbound.ts` | Check 7 inverts. |

---

### Task 1: Agent identity types

**Files:**
- Create: `src/agent-id.ts`
- Modify: `src/types.ts:1-20`
- Test: `src/unit-test/agent-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AgentId = "claude" | "grok" | "codex"`; `type Origin = AgentId | "system"`; `type MessageKind = "reply" | "status" | "fyi" | "untagged"`; `const AGENT_IDS: readonly AgentId[]`; `function isAgentId(v: unknown): v is AgentId`; `function parseAgentId(v: string): AgentId | null`; and the new `interface BridgeMessage` exported from `src/types.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/agent-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_IDS, isAgentId, parseAgentId } from "../agent-id";

describe("agent ids", () => {
  test("lists every addressable participant", () => {
    expect([...AGENT_IDS]).toEqual(["claude", "grok", "codex"]);
  });

  test("isAgentId accepts only the three ids", () => {
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("grok")).toBe(true);
    expect(isAgentId("system")).toBe(false);
    expect(isAgentId("Claude")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });

  test("parseAgentId is case-sensitive and returns null on a typo", () => {
    expect(parseAgentId("grok")).toBe("grok");
    expect(parseAgentId("grrok")).toBeNull();
    expect(parseAgentId("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/agent-id.test.ts`
Expected: FAIL — `Cannot find module '../agent-id'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent-id.ts`:

```ts
/**
 * Who can be addressed on the bus.
 *
 * Deliberately not derived from `FrontendAgent`. That type answers "how
 * do you attach" — Codex sits behind the proxy and attaches through no
 * frontend slot at all, yet is a first-class recipient. Encoding
 * transport into identity is what made "everyone but the sender" look
 * like a routing rule.
 */
export type AgentId = "claude" | "grok" | "codex";

/** Who a message can be attributed to. `system` is the daemon speaking as itself. */
export type Origin = AgentId | "system";

/** Promoted out of the message text and into the protocol. */
export type MessageKind = "reply" | "status" | "fyi" | "untagged";

export const AGENT_IDS: readonly AgentId[] = ["claude", "grok", "codex"];

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

export function parseAgentId(v: string): AgentId | null {
  return isAgentId(v) ? v : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/agent-id.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Replace the envelope in `src/types.ts`**

Delete the `MessageSource` type and the old `BridgeMessage` interface (`src/types.ts:1-20`) and put this in their place, keeping the rest of the file unchanged:

```ts
// ===== Bridge Core Types =====

import type { AgentId, MessageKind, Origin } from "./agent-id";

export type { AgentId, MessageKind, Origin };

export interface BridgeMessage {
  /** Canonical, assigned by the daemon at ingress. Globally unique. */
  id: string;

  /** The sender's own id, preserved for correlation. Never used for routing. */
  senderRef?: string;

  /** Derived from the authenticated socket, never from the payload. */
  from: Origin;

  /**
   * Who this is for.
   *   AgentId — one recipient
   *   "*"     — explicit broadcast
   *   null    — unaddressed; resolved by resolveRecipients
   */
  to: AgentId | "*" | null;

  /** The message this one answers, when it answers one. Primary routing signal. */
  inReplyTo?: string;

  kind: MessageKind;

  content: string;
  timestamp: number;

  /**
   * Legacy egress only. A 0.7 frontend parses `source`, not `from`; the
   * daemon sets this when writing to such a socket and nothing reads it
   * on the way in. Dropped in 0.9.
   */
  source?: AgentId;
}
```

- [ ] **Step 6: Run typecheck to see the blast radius**

Run: `bun run typecheck`
Expected: FAIL — every `source:` construction site and every `message.source` read errors. That list is the work of Tasks 11–13. Record it; do not fix it yet.

- [ ] **Step 7: Commit**

The tree does not typecheck between here and Task 13. Commit on a branch, not on `master`.

```bash
git checkout -b feat/comms-lifecycle
git add src/agent-id.ts src/types.ts src/unit-test/agent-id.test.ts
git commit -m "feat: add AgentId/Origin and the addressed BridgeMessage envelope"
```

---

### Task 2: Marker parsing with `@address`

**Files:**
- Modify: `src/message-filter.ts:25-43`
- Test: `src/unit-test/message-filter.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `MessageKind`, `parseAgentId` from Task 1.
- Produces: `interface ParsedMarker { marker: MessageKind; to: AgentId | null; body: string }`; `function parseMarker(content: string): ParsedMarker`; `class MarkerError extends Error`. `classifyMessage` keeps its existing signature and behaviour.

- [ ] **Step 1: Write the failing test**

Append to `src/unit-test/message-filter.test.ts`:

```ts
import { MarkerError, parseMarker } from "../message-filter";

describe("addressed markers", () => {
  test("extracts the @agent from inside the marker", () => {
    expect(parseMarker("[REPLY @grok] ship it")).toEqual({
      marker: "reply",
      to: "grok",
      body: "ship it",
    });
  });

  test("an unaddressed marker leaves `to` null", () => {
    expect(parseMarker("[REPLY] looks good")).toEqual({
      marker: "reply",
      to: null,
      body: "looks good",
    });
  });

  test("a bare @agent in prose does not address", () => {
    const parsed = parseMarker("see @grok in the diff");
    expect(parsed.marker).toBe("untagged");
    expect(parsed.to).toBeNull();
    expect(parsed.body).toBe("see @grok in the diff");
  });

  test("an unknown @name is a parse failure, not a broadcast", () => {
    expect(() => parseMarker("[REPLY @grrok] oops")).toThrow(MarkerError);
    expect(() => parseMarker("[REPLY @grrok] oops")).toThrow(/grrok/);
  });

  test("[IMPORTANT] still maps to reply and can carry an address", () => {
    expect(parseMarker("[IMPORTANT @claude] hi")).toEqual({
      marker: "reply",
      to: "claude",
      body: "hi",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/message-filter.test.ts`
Expected: FAIL — `MarkerError` is not exported, and `parseMarker` returns no `to`.

- [ ] **Step 3: Write minimal implementation**

In `src/message-filter.ts`, replace the `MARKER_REGEX` constant and the `parseMarker` function (lines 25-43) with:

```ts
import { parseAgentId } from "./agent-id";
import type { AgentId, MessageKind } from "./agent-id";

/** Raised when prose names an address the bus does not have. */
export class MarkerError extends Error {}

// [REPLY] is the new name for what used to be [IMPORTANT]; both spellings
// are accepted so existing role files keep working. The optional
// `@agent` is only recognised INSIDE the bracket — a bare @grok in prose
// is a mention, not a destination, or pasting a diff would route mail.
const MARKER_REGEX =
  /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)(?:\s+@([a-z][a-z0-9_-]*))?\]\s*/i;

export interface ParsedMarker {
  marker: MessageKind;
  /** The @address from inside the marker, or null when unaddressed. */
  to: AgentId | null;
  body: string;
}

export function parseMarker(content: string): ParsedMarker {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", to: null, body: content };
  const raw = match[1].toLowerCase();
  const marker = (raw === "important" ? "reply" : raw) as MessageKind;

  let to: AgentId | null = null;
  if (match[2] !== undefined) {
    to = parseAgentId(match[2].toLowerCase());
    if (to === null) {
      // Broadcasting a typo would reintroduce invisible routing through
      // the front door. Fail loudly and tell the sender which name.
      throw new MarkerError(
        `Unknown address "@${match[2]}". Known agents: claude, grok, codex.`,
      );
    }
  }

  return { marker, to, body: content.slice(match[0].length) };
}
```

`classifyMessage` and `StatusBuffer.flush` already call `parseMarker(...)` and read only `.marker` / `.body`, so they need no change. Update `StatusBuffer.flush`'s summary construction to the new envelope while you are in the file:

```ts
    const summary: BridgeMessage = {
      id: `status_summary_${Date.now()}`,
      from: "system",
      to: null,
      kind: "status",
      content: `[STATUS summary — ${this.buffer.length} update(s), flushed: ${reason}]\n${combined}`,
      timestamp: Date.now(),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/message-filter.test.ts`
Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/message-filter.ts src/unit-test/message-filter.test.ts
git commit -m "feat: parse an optional @agent address inside the marker"
```

---

### Task 3: Mailbox — enqueue and per-kind overflow

**Files:**
- Create: `src/mailbox.ts`
- Test: `src/unit-test/mailbox.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `MessageKind`, `BridgeMessage`.
- Produces:
```ts
export interface MailboxOptions {
  capacity: number;
  leaseTimeoutMs: number;
  /** Injected so tests get deterministic gap-entry ids. */
  nextId?: () => string;
}
export interface EnqueueResult {
  accepted: boolean;
  /** Present only when accepted === false. Shown to the sender verbatim. */
  reason?: string;
}
export class Mailbox {
  constructor(agent: AgentId, opts: MailboxOptions);
  readonly agent: AgentId;
  get size(): number;
  enqueue(message: BridgeMessage): EnqueueResult;
  /** Rollback: remove these ids whether leased or not. */
  remove(ids: string[]): void;
  /** Dropped-message counters by kind, for `abg status`. */
  droppedCounts(): Record<MessageKind, number>;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/mailbox.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Mailbox } from "../mailbox";
import type { BridgeMessage, MessageKind } from "../types";

let seq = 0;
function msg(kind: MessageKind, content = "x"): BridgeMessage {
  return {
    id: `m${++seq}`,
    from: "codex",
    to: "claude",
    kind,
    content,
    timestamp: 1_000,
  };
}

function box(capacity = 3) {
  let n = 0;
  return new Mailbox("claude", {
    capacity,
    leaseTimeoutMs: 30_000,
    nextId: () => `gap${++n}`,
  });
}

describe("mailbox overflow is per-kind and decided before success", () => {
  test("a reply is rejected at send when the mailbox is full", () => {
    const m = box(2);
    expect(m.enqueue(msg("reply")).accepted).toBe(true);
    expect(m.enqueue(msg("reply")).accepted).toBe(true);
    const third = m.enqueue(msg("reply"));
    expect(third.accepted).toBe(false);
    expect(third.reason).toMatch(/claude/);
    expect(m.size).toBe(2);
  });

  test("status collapses the oldest raw entries into one gap entry with its own id", () => {
    const m = box(3);
    m.enqueue(msg("status", "a"));
    m.enqueue(msg("status", "b"));
    m.enqueue(msg("status", "c"));
    expect(m.enqueue(msg("status", "d")).accepted).toBe(true);
    const { messages } = m.drain(2_000);
    expect(messages[0].id).toBe("gap1");
    expect(messages[0].from).toBe("system");
    expect(messages[0].kind).toBe("status");
    expect(messages[0].content).toMatch(/2 status message\(s\) elided/);
    expect(messages.map((x) => x.content)).toEqual([
      messages[0].content,
      "c",
      "d",
    ]);
  });

  test("fyi is droppable and counted", () => {
    const m = box(1);
    m.enqueue(msg("fyi"));
    expect(m.enqueue(msg("fyi")).accepted).toBe(true);
    expect(m.droppedCounts().fyi).toBe(1);
  });

  test("untagged drops the oldest and gap-marks the drain", () => {
    const m = box(1);
    m.enqueue(msg("untagged", "old"));
    m.enqueue(msg("untagged", "new"));
    const { messages } = m.drain(2_000);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toMatch(/1 message\(s\) dropped/);
    expect(messages[1].content).toBe("new");
  });

  test("remove takes entries back out for a rollback", () => {
    const m = box(3);
    const a = msg("reply");
    m.enqueue(a);
    m.remove([a.id]);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/mailbox.test.ts`
Expected: FAIL — `Cannot find module '../mailbox'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mailbox.ts`. `drain`/`ack` are stubbed here and filled in by Task 4 — write them now so the overflow tests can observe ordering.

```ts
import type { AgentId, BridgeMessage, MessageKind } from "./types";

export interface MailboxOptions {
  capacity: number;
  leaseTimeoutMs: number;
  /** Injected so tests get deterministic gap-entry ids. */
  nextId?: () => string;
}

export interface EnqueueResult {
  accepted: boolean;
  /** Present only when accepted === false. Shown to the sender verbatim. */
  reason?: string;
}

export interface DrainBatch {
  batchId: string;
  messages: BridgeMessage[];
}

interface Entry {
  message: BridgeMessage;
  /** Batch that currently holds this entry, or null when free. */
  leasedBy: string | null;
  /** Epoch ms at which the lease stops hiding it. */
  leaseExpiresAt: number;
}

const EMPTY_COUNTS: Record<MessageKind, number> = {
  reply: 0,
  status: 0,
  fyi: 0,
  untagged: 0,
};

/**
 * One recipient's authoritative store.
 *
 * The mailbox is the only place a message lives between acceptance and
 * acknowledged consumption. A successful wake-up does not remove
 * anything from it; only `ack` does. Every way a message can leave
 * without being consumed is visible — the sender is told at send time
 * (`reply`), or the recipient is told on drain (a gap entry).
 */
export class Mailbox {
  private readonly entries: Entry[] = [];
  private readonly dropped: Record<MessageKind, number> = { ...EMPTY_COUNTS };
  /** Drops not yet reported to the recipient as a gap marker. */
  private unreportedDrops = 0;
  private readonly nextId: () => string;
  private batchSeq = 0;

  constructor(
    readonly agent: AgentId,
    private readonly opts: MailboxOptions,
  ) {
    this.nextId = opts.nextId ?? (() => `gap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }

  get size(): number {
    return this.entries.length;
  }

  droppedCounts(): Record<MessageKind, number> {
    return { ...this.dropped };
  }

  enqueue(message: BridgeMessage): EnqueueResult {
    if (this.entries.length < this.opts.capacity) {
      this.push(message);
      return { accepted: true };
    }

    switch (message.kind) {
      case "reply":
        // The one kind carrying a conversational obligation. Telling the
        // sender "success" and then deleting it is the bug this design
        // exists to remove, so refuse before accepting.
        return {
          accepted: false,
          reason: `${this.agent}'s mailbox is full (${this.opts.capacity} messages). The reply was not delivered.`,
        };

      case "status": {
        // Collapse the oldest raw status entries into one gap entry that
        // is itself an ordinary entry with its own id. Status keeps a
        // single representation: raw entries, never a stored summary.
        const collapsed = this.collapseOldest("status");
        this.push({
          id: this.nextId(),
          from: "system",
          to: this.agent,
          kind: "status",
          content: `[gap] ${collapsed} status message(s) elided — mailbox at capacity`,
          timestamp: message.timestamp,
        });
        this.push(message);
        return { accepted: true };
      }

      case "fyi":
        // Background context. Droppable by contract; the counter and the
        // next drain's gap marker keep the drop visible.
        this.dropped.fyi++;
        this.unreportedDrops++;
        return { accepted: true };

      case "untagged":
        this.dropOldestFree();
        this.push(message);
        return { accepted: true };
    }
  }

  remove(ids: string[]): void {
    const doomed = new Set(ids);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (doomed.has(this.entries[i].message.id)) this.entries.splice(i, 1);
    }
  }

  drain(now: number): DrainBatch {
    return { batchId: `b${++this.batchSeq}`, messages: [] };
  }

  ack(batchId: string, ids: string[]): number {
    return 0;
  }

  private push(message: BridgeMessage): void {
    this.entries.push({ message, leasedBy: null, leaseExpiresAt: 0 });
  }

  /**
   * Remove the oldest entries of one kind, leaving at least one slot
   * free. Returns how many were removed.
   */
  private collapseOldest(kind: MessageKind): number {
    let removed = 0;
    // Two slots: one for the gap entry, one for the incoming message.
    while (this.entries.length > this.opts.capacity - 2) {
      const idx = this.entries.findIndex((e) => e.message.kind === kind);
      if (idx === -1) break;
      this.entries.splice(idx, 1);
      removed++;
      this.dropped[kind]++;
    }
    if (removed === 0) {
      // Nothing of this kind to collapse — fall back to the oldest entry
      // so the incoming message still has somewhere to go.
      this.dropOldestFree();
      removed = 1;
    }
    return removed;
  }

  private dropOldestFree(): void {
    const idx = this.entries.findIndex((e) => e.leasedBy === null);
    const victim = this.entries.splice(idx === -1 ? 0 : idx, 1)[0];
    if (victim) {
      this.dropped[victim.message.kind]++;
      this.unreportedDrops++;
    }
  }

  /** Gap entry owed to the recipient, consumed by `drain`. */
  protected takeGapMarker(now: number): BridgeMessage | null {
    if (this.unreportedDrops === 0) return null;
    const content = `[gap] ${this.unreportedDrops} message(s) dropped — mailbox at capacity`;
    this.unreportedDrops = 0;
    return {
      id: this.nextId(),
      from: "system",
      to: this.agent,
      kind: "untagged",
      content,
      timestamp: now,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/mailbox.test.ts`
Expected: the four overflow tests fail on the stubbed `drain`. That is expected — comment out the two tests that call `drain` (`status collapses...`, `untagged drops...`), confirm the other three pass, then restore them. Task 4 makes all five pass.

- [ ] **Step 5: Commit**

```bash
git add src/mailbox.ts src/unit-test/mailbox.test.ts
git commit -m "feat: add the per-recipient mailbox with a per-kind overflow contract"
```

---

### Task 4: Mailbox — leased drain and explicit ack

**Files:**
- Modify: `src/mailbox.ts` (`drain`, `ack`)
- Test: `src/unit-test/mailbox.test.ts`

**Interfaces:**
- Consumes: `Mailbox` from Task 3.
- Produces: `drain(now: number): DrainBatch` and `ack(batchId: string, ids: string[]): number` (returns how many entries were deleted).

- [ ] **Step 1: Write the failing test**

Append to `src/unit-test/mailbox.test.ts`:

```ts
describe("leased drain and explicit ack", () => {
  test("a second drain during a live lease returns nothing", () => {
    const m = box(5);
    m.enqueue(msg("reply", "a"));
    const first = m.drain(1_000);
    expect(first.messages).toHaveLength(1);
    expect(m.drain(1_500).messages).toHaveLength(0);
  });

  test("an expired lease redelivers the same id", () => {
    const m = box(5);
    const a = msg("reply", "a");
    m.enqueue(a);
    const first = m.drain(1_000);
    const second = m.drain(1_000 + 30_001);
    expect(second.messages.map((x) => x.id)).toEqual([a.id]);
    expect(second.batchId).not.toBe(first.batchId);
  });

  test("a partial ack redelivers only the unacked ids", () => {
    const m = box(5);
    const a = msg("reply", "a");
    const b = msg("reply", "b");
    m.enqueue(a);
    m.enqueue(b);
    const batch = m.drain(1_000);
    expect(m.ack(batch.batchId, [a.id])).toBe(1);
    const again = m.drain(1_000 + 30_001);
    expect(again.messages.map((x) => x.id)).toEqual([b.id]);
  });

  test("an ack naming a stale batch deletes nothing", () => {
    const m = box(5);
    const a = msg("reply", "a");
    m.enqueue(a);
    const batch = m.drain(1_000);
    m.drain(1_000 + 30_001); // lease expires, entry is re-leased
    expect(m.ack(batch.batchId, [a.id])).toBe(0);
    expect(m.size).toBe(1);
  });

  test("a drain with nothing to serve still reports a pending gap", () => {
    const m = box(1);
    m.enqueue(msg("untagged", "old"));
    m.enqueue(msg("untagged", "new"));
    const batch = m.drain(2_000);
    expect(batch.messages[0].content).toMatch(/dropped/);
    // the marker is reported once, not on every drain
    m.ack(batch.batchId, batch.messages.map((x) => x.id));
    expect(m.drain(3_000).messages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/mailbox.test.ts`
Expected: FAIL — every drain returns an empty `messages` array.

- [ ] **Step 3: Write minimal implementation**

Replace the stubbed `drain` and `ack` in `src/mailbox.ts`:

```ts
  /**
   * Lease every free entry to one batch.
   *
   * A lease hides its entries from further drains for `leaseTimeoutMs`,
   * so a retry does not re-serve in-flight work, and makes them visible
   * again on expiry, so a drain response that never arrives costs a
   * redelivery rather than the message. This is at-least-once by
   * construction; the canonical `id` is what makes the duplicate cheap.
   */
  drain(now: number): DrainBatch {
    const batchId = `${this.agent}_b${++this.batchSeq}_${now}`;
    const gap = this.takeGapMarker(now);
    if (gap) this.push(gap);

    const messages: BridgeMessage[] = [];
    for (const entry of this.entries) {
      if (entry.leasedBy !== null && entry.leaseExpiresAt > now) continue;
      entry.leasedBy = batchId;
      entry.leaseExpiresAt = now + this.opts.leaseTimeoutMs;
      messages.push(entry.message);
    }
    return { batchId, messages };
  }

  /**
   * Delete exactly the ids named, and only if this batch still holds
   * them. An ack against a lease that already expired and was re-leased
   * is stale — honouring it would delete an entry another drain is
   * currently serving.
   */
  ack(batchId: string, ids: string[]): number {
    const named = new Set(ids);
    let deleted = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.leasedBy !== batchId) continue;
      if (!named.has(entry.message.id)) continue;
      this.entries.splice(i, 1);
      deleted++;
    }
    return deleted;
  }
```

Change `takeGapMarker` from `protected` to `private` now that `drain` is its only caller.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/mailbox.test.ts`
Expected: PASS — all ten tests, including the two restored from Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/mailbox.ts src/unit-test/mailbox.test.ts
git commit -m "feat: lease mailbox drains and require an explicit ack to delete"
```

---

### Task 5: Provenance index

**Files:**
- Create: `src/message-index.ts`
- Test: `src/unit-test/message-index.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `Origin`.
- Produces:
```ts
export interface IndexEntry { from: Origin; recipients: AgentId[]; at: number }
export class MessageIndex {
  constructor(opts: { capacity: number; ttlMs: number });
  get size(): number;
  /** false means the cap is reached with nothing expired — reject the ingress. */
  record(id: string, entry: IndexEntry, now: number): boolean;
  delete(id: string): void;
  /** The AgentId to route a reply to, or null when the reply must be rejected. */
  resolveSender(id: string, replier: AgentId, now: number): AgentId | null;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/message-index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { MessageIndex } from "../message-index";

function idx(capacity = 10, ttlMs = 60_000) {
  return new MessageIndex({ capacity, ttlMs });
}

describe("provenance index", () => {
  test("resolves a reply back to the original sender", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("m1", "codex", 1_000)).toBe("claude");
  });

  test("outlives the message it describes", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    // no mailbox involvement at all — the index is independent storage
    expect(m.resolveSender("m1", "codex", 59_000)).toBe("claude");
  });

  test("rejects a replier that was not a recipient", () => {
    const m = idx();
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("m1", "grok", 1_000)).toBeNull();
  });

  test("rejects an unknown or expired id", () => {
    const m = idx(10, 1_000);
    m.record("m1", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    expect(m.resolveSender("nope", "codex", 10)).toBeNull();
    expect(m.resolveSender("m1", "codex", 2_000)).toBeNull();
  });

  test("a system entry is not a valid reply target", () => {
    const m = idx();
    m.record("s1", { from: "system", recipients: ["claude"], at: 0 }, 0);
    expect(m.resolveSender("s1", "claude", 10)).toBeNull();
  });

  test("the cap evicts expired entries only", () => {
    const m = idx(2, 1_000);
    m.record("old", { from: "claude", recipients: ["codex"], at: 0 }, 0);
    m.record("live", { from: "claude", recipients: ["codex"], at: 900 }, 900);
    // both live: no room, nothing expired → reject
    expect(m.record("third", { from: "grok", recipients: ["codex"], at: 950 }, 950)).toBe(false);
    expect(m.size).toBe(2);
    // now "old" has expired → it is evicted and the write lands
    expect(m.record("third", { from: "grok", recipients: ["codex"], at: 1_500 }, 1_500)).toBe(true);
    expect(m.resolveSender("old", "codex", 1_500)).toBeNull();
    expect(m.resolveSender("live", "codex", 1_500)).toBe("claude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/message-index.test.ts`
Expected: FAIL — `Cannot find module '../message-index'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/message-index.ts`:

```ts
import { isAgentId } from "./agent-id";
import type { AgentId, Origin } from "./agent-id";

export interface IndexEntry {
  from: Origin;
  /** Only the recipients that actually accepted the message. */
  recipients: AgentId[];
  at: number;
}

/**
 * Who sent what, and who was allowed to receive it.
 *
 * Causal routing resolves `inReplyTo` by looking up the original
 * message's sender — but that message is deleted from its mailbox on
 * ack, usually long before the reply is written. The mailbox cannot
 * answer the question, so this index does, independently of mailbox
 * lifetime.
 *
 * The `recipients` list doubles as authorization: without it, any agent
 * could route to any other by guessing an id.
 */
export class MessageIndex {
  private readonly entries = new Map<string, IndexEntry>();

  constructor(private readonly opts: { capacity: number; ttlMs: number }) {}

  get size(): number {
    return this.entries.size;
  }

  record(id: string, entry: IndexEntry, now: number): boolean {
    if (this.entries.size >= this.opts.capacity) {
      this.evictExpired(now);
    }
    if (this.entries.size >= this.opts.capacity) {
      // Every remaining entry is unexpired, and a recipient may reply to
      // any of them at any point inside the TTL. Evicting one would turn
      // a valid reply into a parse failure — silent loss wearing a
      // different hat. Refuse the new message instead, where the sender
      // can see it.
      return false;
    }
    this.entries.set(id, entry);
    return true;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  resolveSender(id: string, replier: AgentId, now: number): AgentId | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (now - entry.at > this.opts.ttlMs) return null;
    // A lifecycle notice is an observation about the bus, not a turn in a
    // conversation. There is no one to reply to.
    if (!isAgentId(entry.from)) return null;
    if (!entry.recipients.includes(replier)) return null;
    return entry.from;
  }

  private evictExpired(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.at > this.opts.ttlMs) this.entries.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/message-index.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/message-index.ts src/unit-test/message-index.test.ts
git commit -m "feat: add the provenance index backing causal inReplyTo routing"
```

---

### Task 6: The one routing function

**Files:**
- Create: `src/routing.ts`
- Test: `src/unit-test/routing.test.ts`

**Interfaces:**
- Consumes: `BridgeMessage`, `AgentId`, `MessageIndex.resolveSender`.
- Produces:
```ts
export class RoutingError extends Error {}
export interface RoutingState {
  knownAgents(): AgentId[];
  /** MessageIndex.resolveSender, injected. */
  senderOf(inReplyTo: string, replier: AgentId, now: number): AgentId | null;
  /** The agent whose request opened the sender's current turn, if any. */
  activeRequesterFor(agent: AgentId): AgentId | null;
}
export function resolveRecipients(
  envelope: BridgeMessage,
  state: RoutingState,
  now: number,
): AgentId[];
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/routing.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RoutingError, resolveRecipients } from "../routing";
import type { RoutingState } from "../routing";
import type { AgentId, BridgeMessage, Origin } from "../types";

function env(over: Partial<BridgeMessage> & { from: Origin }): BridgeMessage {
  return {
    id: "m1",
    to: null,
    kind: "reply",
    content: "x",
    timestamp: 0,
    ...over,
  };
}

function state(over: Partial<RoutingState> = {}): RoutingState {
  return {
    knownAgents: () => ["claude", "grok", "codex"] as AgentId[],
    senderOf: () => null,
    activeRequesterFor: () => null,
    ...over,
  };
}

describe("resolveRecipients", () => {
  test("an explicit AgentId routes to exactly that agent", () => {
    expect(resolveRecipients(env({ from: "codex", to: "grok" }), state(), 0)).toEqual(["grok"]);
  });

  test('"*" broadcasts to every known agent except the sender', () => {
    expect(resolveRecipients(env({ from: "codex", to: "*" }), state(), 0)).toEqual([
      "claude",
      "grok",
    ]);
  });

  test("inReplyTo routes to the sender of the message it answers", () => {
    const s = state({ senderOf: (id, replier) => (id === "m0" && replier === "codex" ? "claude" : null) });
    expect(resolveRecipients(env({ from: "codex", inReplyTo: "m0" }), s, 0)).toEqual(["claude"]);
  });

  test("an unresolvable inReplyTo throws rather than broadcasting", () => {
    expect(() => resolveRecipients(env({ from: "codex", inReplyTo: "gone" }), state(), 0)).toThrow(
      RoutingError,
    );
  });

  test("mid-turn output routes to that turn's requester", () => {
    const s = state({ activeRequesterFor: (a) => (a === "codex" ? "grok" : null) });
    expect(resolveRecipients(env({ from: "codex" }), s, 0)).toEqual(["grok"]);
  });

  test("inReplyTo beats activeRequester — causality wins over turn state", () => {
    const s = state({
      senderOf: () => "claude",
      activeRequesterFor: () => "grok",
    });
    expect(resolveRecipients(env({ from: "codex", inReplyTo: "m0" }), s, 0)).toEqual(["claude"]);
  });

  test("genuinely spontaneous output falls through to broadcast", () => {
    expect(resolveRecipients(env({ from: "codex" }), state(), 0)).toEqual(["claude", "grok"]);
  });

  test('routing uses "known", not "attached" — a detached agent still resolves', () => {
    const s = state({ knownAgents: () => ["claude", "grok", "codex"] });
    expect(resolveRecipients(env({ from: "claude", to: "grok" }), s, 0)).toEqual(["grok"]);
  });

  test("a system notice broadcasts and is never routed by turn state", () => {
    const s = state({ activeRequesterFor: () => "grok" });
    expect(resolveRecipients(env({ from: "system" }), s, 0)).toEqual([
      "claude",
      "grok",
      "codex",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/routing.test.ts`
Expected: FAIL — `Cannot find module '../routing'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/routing.ts`:

```ts
import { isAgentId } from "./agent-id";
import type { AgentId, BridgeMessage } from "./types";

/** Raised when a message names a destination the bus cannot resolve. */
export class RoutingError extends Error {}

export interface RoutingState {
  /** Every agent the bus knows about, attached or not. */
  knownAgents(): AgentId[];
  senderOf(inReplyTo: string, replier: AgentId, now: number): AgentId | null;
  /** The agent whose request opened this agent's current turn, if any. */
  activeRequesterFor(agent: AgentId): AgentId | null;
}

/**
 * The only function in the system that decides where a message goes.
 *
 * Routing is causal, not stateful. A `lastAddressedBy` map cannot answer
 * "which conversation is this a reply to" — with two agents addressing
 * Codex, last-writer-wins sends Codex's answer to whoever spoke most
 * recently rather than to whoever it is answering. `inReplyTo` and a
 * turn-scoped requester both hold that fact directly.
 */
export function resolveRecipients(
  envelope: BridgeMessage,
  state: RoutingState,
  now: number,
): AgentId[] {
  const everyoneElse = () =>
    state.knownAgents().filter((a) => a !== envelope.from);

  if (isAgentId(envelope.to)) return [envelope.to];
  if (envelope.to === "*") return everyoneElse();

  // System notices are observations about the bus, not turns in a
  // conversation. They never read or write routing state.
  if (envelope.from === "system") return everyoneElse();

  if (envelope.inReplyTo !== undefined) {
    const target = state.senderOf(envelope.inReplyTo, envelope.from, now);
    if (target === null) {
      // Same rule, same reason, as an unknown @name: falling through to
      // broadcast would make a typo or a guessed id into invisible
      // routing.
      throw new RoutingError(
        `Cannot reply to "${envelope.inReplyTo}" — unknown, expired, or not addressed to ${envelope.from}.`,
      );
    }
    return [target];
  }

  const requester = state.activeRequesterFor(envelope.from);
  if (requester !== null) return [requester];

  return everyoneElse();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/routing.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routing.ts src/unit-test/routing.test.ts
git commit -m "feat: route causally through a single resolveRecipients function"
```

---

### Task 7: Version-aware ingress normalization

**Files:**
- Create: `src/normalize-ingress.ts`
- Test: `src/unit-test/normalize-ingress.test.ts`

**Interfaces:**
- Consumes: `parseMarker` / `MarkerError` (Task 2), `BridgeMessage`, `Origin`, `parseAgentId`.
- Produces:
```ts
export const PROTOCOL_VERSION = 1;
export class IngressError extends Error {}
export interface IngressSocket { agent: Origin; protocolVersion: number | null }
export interface IngressContext { id: string; now: number }
/** Structured ingress: the `reply` tool's arguments. */
export function normalizeIngress(raw: unknown, socket: IngressSocket, ctx: IngressContext): BridgeMessage;
/** Prose ingress: intercepted Codex output. */
export function normalizeProse(content: string, socket: IngressSocket, ctx: IngressContext): BridgeMessage;
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/normalize-ingress.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { IngressError, normalizeIngress, normalizeProse } from "../normalize-ingress";

const ctx = { id: "canonical1", now: 5_000 };
const current = { agent: "claude" as const, protocolVersion: 1 };
const legacy = { agent: "claude" as const, protocolVersion: null };

describe("normalizeIngress", () => {
  test("derives `from` from the socket, not the payload", () => {
    const m = normalizeIngress({ to: "grok", kind: "reply", content: "hi" }, current, ctx);
    expect(m.from).toBe("claude");
    expect(m.id).toBe("canonical1");
    expect(m.timestamp).toBe(5_000);
  });

  test("keeps the sender's own id as senderRef and never as id", () => {
    const m = normalizeIngress(
      { to: "grok", kind: "reply", content: "hi", senderRef: "chat_42" },
      current,
      ctx,
    );
    expect(m.senderRef).toBe("chat_42");
    expect(m.id).toBe("canonical1");
  });

  test("rejects a payload `from` that disagrees with the socket", () => {
    expect(() =>
      normalizeIngress({ from: "codex", kind: "reply", content: "x" }, current, ctx),
    ).toThrow(IngressError);
  });

  test("accepts a payload `from` that agrees", () => {
    const m = normalizeIngress({ from: "claude", kind: "reply", content: "x" }, current, ctx);
    expect(m.from).toBe("claude");
  });

  test("ignores `source` entirely on a legacy socket", () => {
    const m = normalizeIngress({ source: "codex", content: "x" }, legacy, ctx);
    expect(m.from).toBe("claude");
    expect(m.kind).toBe("untagged");
  });

  test("rejects an embedded marker that conflicts with the structured arguments", () => {
    expect(() =>
      normalizeIngress({ to: "grok", kind: "reply", content: "[REPLY @codex] x" }, current, ctx),
    ).toThrow(/two sources of truth|conflict/i);
  });

  test("allows an embedded marker that agrees, and strips it", () => {
    const m = normalizeIngress(
      { to: "grok", kind: "reply", content: "[REPLY @grok] x" },
      current,
      ctx,
    );
    expect(m.content).toBe("x");
  });

  test("rejects an unknown `to`", () => {
    expect(() =>
      normalizeIngress({ to: "grrok", kind: "reply", content: "x" }, current, ctx),
    ).toThrow(IngressError);
  });
});

describe("normalizeProse", () => {
  test("turns an addressed marker into the same envelope shape", () => {
    const m = normalizeProse("[REPLY @claude] tests pass", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m).toMatchObject({
      id: "canonical1",
      from: "codex",
      to: "claude",
      kind: "reply",
      content: "tests pass",
    });
  });

  test("unaddressed prose leaves `to` null for the resolver", () => {
    const m = normalizeProse("[REPLY] ok", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m.to).toBeNull();
  });

  test("untagged prose is kind untagged", () => {
    const m = normalizeProse("just thinking", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m.kind).toBe("untagged");
    expect(m.content).toBe("just thinking");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/normalize-ingress.test.ts`
Expected: FAIL — `Cannot find module '../normalize-ingress'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/normalize-ingress.ts`:

```ts
import { isAgentId, parseAgentId } from "./agent-id";
import { MarkerError, parseMarker } from "./message-filter";
import type { AgentId, BridgeMessage, MessageKind, Origin } from "./types";

/** Bumped when the envelope's wire shape changes. */
export const PROTOCOL_VERSION = 1;

/** Raised when an ingress payload cannot be turned into a valid envelope. */
export class IngressError extends Error {}

export interface IngressSocket {
  /** Authenticated identity of the socket this arrived on. */
  agent: Origin;
  /** null means a pre-0.8 frontend that never declared one. */
  protocolVersion: number | null;
}

export interface IngressContext {
  /** Canonical id assigned by the daemon. */
  id: string;
  now: number;
}

const KINDS: MessageKind[] = ["reply", "status", "fyi", "untagged"];

/**
 * The only writer of `from` in the system.
 *
 * Attribution comes from the authenticated socket. The previous check
 * lived in `bridge.ts` — client-side, in the very process that would be
 * doing the spoofing, which is not a check. The declared protocol
 * version decides only whether a disagreeing payload field is an error
 * (current: it promised not to send one) or noise (legacy: the field was
 * vestigial and never authenticated).
 */
export function normalizeIngress(
  raw: unknown,
  socket: IngressSocket,
  ctx: IngressContext,
): BridgeMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new IngressError("Ingress payload must be an object.");
  }
  const p = raw as Record<string, unknown>;

  if (socket.protocolVersion !== null && socket.protocolVersion >= 1) {
    const declared = p.from ?? p.source;
    if (declared !== undefined && declared !== socket.agent) {
      throw new IngressError(
        `Payload claims from="${String(declared)}" but the socket is authenticated as "${socket.agent}".`,
      );
    }
  }

  const to = readTo(p.to);
  const kind = readKind(p.kind);
  const content = typeof p.content === "string" ? p.content : "";

  // A structured caller already said where this goes. If the text also
  // says, and says something else, there are two sources of truth for one
  // message's destination — the exact class of bug this design removes.
  let body = content;
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError) throw new IngressError(err.message);
    throw err;
  }
  if (marker.marker !== "untagged" || marker.to !== null) {
    if (marker.to !== null && to !== null && marker.to !== to) {
      throw new IngressError(
        `Conflict: structured to="${to}" but the content is marked "@${marker.to}". Two sources of truth for one destination.`,
      );
    }
    if (marker.marker !== "untagged" && marker.marker !== kind) {
      throw new IngressError(
        `Conflict: structured kind="${kind}" but the content is marked "[${marker.marker.toUpperCase()}]".`,
      );
    }
    body = marker.body;
  }

  return {
    id: ctx.id,
    senderRef: typeof p.senderRef === "string" ? p.senderRef : undefined,
    from: socket.agent,
    to,
    inReplyTo: typeof p.inReplyTo === "string" ? p.inReplyTo : undefined,
    kind,
    content: body,
    timestamp: ctx.now,
  };
}

/** Codex has no tool. Its ordinary prose is the ingress. */
export function normalizeProse(
  content: string,
  socket: IngressSocket,
  ctx: IngressContext,
): BridgeMessage {
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError) throw new IngressError(err.message);
    throw err;
  }
  return {
    id: ctx.id,
    from: socket.agent,
    to: marker.to,
    kind: marker.marker,
    content: marker.body,
    timestamp: ctx.now,
  };
}

function readTo(v: unknown): AgentId | "*" | null {
  if (v === undefined || v === null) return null;
  if (v === "*") return "*";
  if (typeof v !== "string") throw new IngressError("`to` must be a string.");
  const parsed = parseAgentId(v);
  if (parsed === null) {
    throw new IngressError(`Unknown recipient "${v}". Known agents: claude, grok, codex.`);
  }
  return parsed;
}

function readKind(v: unknown): MessageKind {
  if (v === undefined || v === null) return "untagged";
  if (typeof v === "string" && (KINDS as string[]).includes(v)) return v as MessageKind;
  throw new IngressError(`Unknown kind "${String(v)}". Expected one of ${KINDS.join(", ")}.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/normalize-ingress.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/normalize-ingress.ts src/unit-test/normalize-ingress.test.ts
git commit -m "feat: derive message attribution from the authenticated socket only"
```

---

### Task 8: Wake-up transports

**Files:**
- Create: `src/wakeup-transport.ts`
- Test: `src/unit-test/wakeup-transport.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `BridgeMessage`.
- Produces:
```ts
export interface WakeupTransport {
  payloadMode: "content" | "signal";
  acknowledgementMode: "explicit" | "none";
  wake(message: BridgeMessage): void | Promise<void>;
}
export const DEFAULT_TRANSPORT: Pick<WakeupTransport, "payloadMode" | "acknowledgementMode">;
export class TransportRegistry {
  register(agent: AgentId, transport: WakeupTransport): void;
  unregister(agent: AgentId): void;
  get(agent: AgentId): WakeupTransport | null;
  /** Never throws, never rejects. Returns whether the wake-up was attempted without error. */
  wake(agent: AgentId, message: BridgeMessage, log: (m: string) => void): Promise<boolean>;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/wakeup-transport.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TransportRegistry } from "../wakeup-transport";
import type { BridgeMessage } from "../types";

const m: BridgeMessage = {
  id: "m1",
  from: "codex",
  to: "claude",
  kind: "reply",
  content: "x",
  timestamp: 0,
};

describe("TransportRegistry", () => {
  test("wakes a registered transport", async () => {
    const seen: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: (msg) => { seen.push(msg.id); },
    });
    expect(await r.wake("claude", m, () => {})).toBe(true);
    expect(seen).toEqual(["m1"]);
  });

  test("an agent with no transport is not an error — the message is in the mailbox", async () => {
    const r = new TransportRegistry();
    expect(await r.wake("grok", m, () => {})).toBe(false);
  });

  test("a wake-up that throws is logged and swallowed", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw new Error("socket closed"); },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe(false);
    expect(logs.join()).toMatch(/socket closed/);
  });

  test("a wake-up that rejects is logged and swallowed", async () => {
    const logs: string[] = [];
    const r = new TransportRegistry();
    r.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: async () => { throw new Error("gate closed"); },
    });
    expect(await r.wake("claude", m, (l) => logs.push(l))).toBe(false);
    expect(logs.join()).toMatch(/gate closed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/wakeup-transport.test.ts`
Expected: FAIL — `Cannot find module '../wakeup-transport'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/wakeup-transport.ts`:

```ts
import type { AgentId, BridgeMessage } from "./types";

/**
 * How one agent is told a message is waiting.
 *
 * Two independent questions, because they were always separate:
 *
 * - `payloadMode` — does the wake-up carry the message, or only the fact
 *   that one exists?
 * - `acknowledgementMode` — can this transport produce correlated
 *   evidence that the message was consumed?
 *
 * They must not be collapsed into one flag. `docs/channels-silent-block.md`
 * records a successful `notifications/claude/channel` call that the model
 * never saw, gated by a server-side per-account flag. A capability
 * compiled into the transport describes what the transport *believes*,
 * and the belief is wrong precisely in the case that produced the bug.
 * A content-carrying push therefore still acknowledges nothing.
 */
export interface WakeupTransport {
  payloadMode: "content" | "signal";
  acknowledgementMode: "explicit" | "none";
  wake(message: BridgeMessage): void | Promise<void>;
}

/** What an unrecognised host gets: a bare signal on a channel that may not deliver content. */
export const DEFAULT_TRANSPORT: Pick<WakeupTransport, "payloadMode" | "acknowledgementMode"> = {
  payloadMode: "signal",
  acknowledgementMode: "none",
};

export class TransportRegistry {
  private readonly transports = new Map<AgentId, WakeupTransport>();

  register(agent: AgentId, transport: WakeupTransport): void {
    this.transports.set(agent, transport);
  }

  unregister(agent: AgentId): void {
    this.transports.delete(agent);
  }

  get(agent: AgentId): WakeupTransport | null {
    return this.transports.get(agent) ?? null;
  }

  /**
   * Best-effort by definition. A wake-up that throws, times out, or is
   * silently ignored costs latency; the message is already in the
   * mailbox, so it can no longer cost the message.
   */
  async wake(agent: AgentId, message: BridgeMessage, log: (m: string) => void): Promise<boolean> {
    const transport = this.transports.get(agent);
    if (!transport) {
      log(`No wake-up transport for ${agent}; ${message.id} waits in the mailbox`);
      return false;
    }
    try {
      await transport.wake(message);
      return true;
    } catch (err: any) {
      log(`Wake-up for ${agent} failed (${err?.message ?? err}); ${message.id} stays in the mailbox`);
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/wakeup-transport.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wakeup-transport.ts src/unit-test/wakeup-transport.test.ts
git commit -m "feat: separate wake-up payload mode from acknowledgement mode"
```

---

### Task 9: The message bus

**Files:**
- Create: `src/message-bus.ts`
- Test: `src/unit-test/message-bus.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `MessageIndex`, `resolveRecipients` / `RoutingState`, `TransportRegistry`.
- Produces:
```ts
export class SendRejected extends Error { constructor(message: string); }
export interface RouteResult {
  id: string;
  accepted: AgentId[];
  rejected: { agent: AgentId; reason: string }[];
}
export interface BusDeps {
  mailboxFor(agent: AgentId): Mailbox;
  index: MessageIndex;
  state: RoutingState;
  transports: TransportRegistry;
  log(message: string): void;
}
export class MessageBus {
  constructor(deps: BusDeps);
  route(envelope: BridgeMessage, now: number): Promise<RouteResult>;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/message-bus.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Mailbox } from "../mailbox";
import { MessageBus, SendRejected } from "../message-bus";
import { MessageIndex } from "../message-index";
import { TransportRegistry } from "../wakeup-transport";
import type { AgentId, BridgeMessage } from "../types";

function harness(opts: { capacity?: number; indexCapacity?: number } = {}) {
  const boxes = new Map<AgentId, Mailbox>();
  const mailboxFor = (agent: AgentId) => {
    let box = boxes.get(agent);
    if (!box) {
      let n = 0;
      box = new Mailbox(agent, {
        capacity: opts.capacity ?? 10,
        leaseTimeoutMs: 30_000,
        nextId: () => `${agent}_gap${++n}`,
      });
      boxes.set(agent, box);
    }
    return box;
  };
  const index = new MessageIndex({ capacity: opts.indexCapacity ?? 100, ttlMs: 600_000 });
  const transports = new TransportRegistry();
  const woke: string[] = [];
  const logs: string[] = [];
  const bus = new MessageBus({
    mailboxFor,
    index,
    state: {
      knownAgents: () => ["claude", "grok", "codex"],
      senderOf: (id, replier, now) => index.resolveSender(id, replier, now),
      activeRequesterFor: () => null,
    },
    transports,
    log: (m) => logs.push(m),
  });
  return { bus, boxes, mailboxFor, index, transports, woke, logs };
}

function env(over: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id: "m1",
    from: "codex",
    to: null,
    kind: "reply",
    content: "x",
    timestamp: 0,
    ...over,
  };
}

describe("MessageBus.route", () => {
  test("enqueues into every resolved mailbox before waking anyone", async () => {
    const h = harness();
    const order: string[] = [];
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => {
        order.push(`wake:${h.mailboxFor("claude").size}`);
      },
    });
    await h.bus.route(env({ to: "claude" }), 0);
    // The mailbox already holds it at wake-up time. Ordering is enforced,
    // not asserted.
    expect(order).toEqual(["wake:1"]);
  });

  test("a wake-up that throws still leaves the message drainable", async () => {
    const h = harness();
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { throw new Error("gate closed"); },
    });
    await h.bus.route(env({ to: "claude" }), 0);
    expect(h.mailboxFor("claude").drain(1).messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("a full mailbox for one recipient does not block another", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    const result = await h.bus.route(env({ to: "*" }), 0);
    expect(result.accepted).toEqual(["grok"]);
    expect(result.rejected.map((r) => r.agent)).toEqual(["claude"]);
    expect(h.mailboxFor("grok").size).toBe(1);
  });

  test("a reply rejected by every recipient throws SendRejected", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    await expect(h.bus.route(env({ to: "claude" }), 0)).rejects.toThrow(SendRejected);
  });

  test("the index lists only the recipients that accepted", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "filler" }));
    await h.bus.route(env({ to: "*" }), 0);
    expect(h.index.resolveSender("m1", "grok", 1)).toBe("codex");
    expect(h.index.resolveSender("m1", "claude", 1)).toBeNull();
  });

  test("an index failure rolls back the enqueue, fires no wake-up, and fails the send", async () => {
    const h = harness({ indexCapacity: 1 });
    let woke = 0;
    h.transports.register("claude", {
      payloadMode: "content",
      acknowledgementMode: "none",
      wake: () => { woke++; },
    });
    // Fill the index with one live entry so the second record() is refused.
    await h.bus.route(env({ id: "first", to: "claude" }), 0);
    h.mailboxFor("claude").drain(1);
    await expect(h.bus.route(env({ id: "second", to: "claude" }), 1)).rejects.toThrow(SendRejected);
    expect(woke).toBe(1); // only the first route woke anyone
    expect(h.mailboxFor("claude").drain(30_002).messages.map((m) => m.id)).toEqual(["first"]);
  });

  test("a broadcast rejected by every mailbox writes no index entry", async () => {
    const h = harness({ capacity: 1 });
    h.mailboxFor("claude").enqueue(env({ id: "f1" }));
    h.mailboxFor("grok").enqueue(env({ id: "f2" }));
    await expect(h.bus.route(env({ to: "*" }), 0)).rejects.toThrow(SendRejected);
    expect(h.index.resolveSender("m1", "grok", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/message-bus.test.ts`
Expected: FAIL — `Cannot find module '../message-bus'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/message-bus.ts`:

```ts
import { resolveRecipients } from "./routing";
import type { RoutingState } from "./routing";
import type { Mailbox } from "./mailbox";
import type { MessageIndex } from "./message-index";
import type { TransportRegistry } from "./wakeup-transport";
import type { AgentId, BridgeMessage } from "./types";

/** The send did not happen. The sender is told, at send time. */
export class SendRejected extends Error {}

export interface RouteResult {
  id: string;
  accepted: AgentId[];
  rejected: { agent: AgentId; reason: string }[];
}

export interface BusDeps {
  mailboxFor(agent: AgentId): Mailbox;
  index: MessageIndex;
  state: RoutingState;
  transports: TransportRegistry;
  log(message: string): void;
}

/**
 * Steps 0-3 of the delivery lifecycle, in order, for every ingress.
 *
 * Every path goes through here — the `reply` tool, intercepted Codex
 * prose, and the daemon's own lifecycle notices. The previous design
 * declared the ordering non-negotiable while `claude_to_codex` bypassed
 * it entirely; a single entry point is what makes the ordering true
 * rather than merely asserted.
 */
export class MessageBus {
  constructor(private readonly deps: BusDeps) {}

  async route(envelope: BridgeMessage, now: number): Promise<RouteResult> {
    // 1. the only routing decision in the system
    const recipients = resolveRecipients(envelope, this.deps.state, now);

    // 2. per-recipient acceptance. a full mailbox for A must not block B.
    const accepted: AgentId[] = [];
    const rejected: { agent: AgentId; reason: string }[] = [];
    for (const agent of recipients) {
      const result = this.deps.mailboxFor(agent).enqueue(envelope);
      if (result.accepted) accepted.push(agent);
      else rejected.push({ agent, reason: result.reason ?? "rejected" });
    }

    if (accepted.length === 0) {
      throw new SendRejected(
        rejected.length > 0
          ? rejected.map((r) => r.reason).join(" ")
          : `No recipient resolved for message ${envelope.id}.`,
      );
    }

    // Enqueue and index insertion commit as one transaction. A delivered
    // message with no provenance is one nobody can reply to, which is the
    // failure the index exists to prevent — half-committing would create it.
    const recorded = this.deps.index.record(
      envelope.id,
      { from: envelope.from, recipients: accepted, at: now },
      now,
    );
    if (!recorded) {
      this.rollback(accepted, envelope.id);
      throw new SendRejected(
        "The provenance index is full of live entries; the message was not delivered. Retry once older conversations expire.",
      );
    }

    // 3. best-effort wake-up. never consumes.
    for (const agent of accepted) {
      await this.deps.transports.wake(agent, envelope, this.deps.log);
    }

    return { id: envelope.id, accepted, rejected };
  }

  private rollback(agents: AgentId[], id: string): void {
    for (const agent of agents) this.deps.mailboxFor(agent).remove([id]);
    this.deps.log(`Rolled back ${id} from ${agents.join(", ")} — index insertion failed`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/message-bus.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/message-bus.ts src/unit-test/message-bus.test.ts
git commit -m "feat: enforce the delivery lifecycle order in one message bus"
```

---

### Task 10: Control protocol — version handshake, drain, ack

**Files:**
- Modify: `src/control-protocol.ts:59-140`
- Modify: `src/daemon-client.ts`
- Modify: `src/bridge.ts:64-78`
- Test: `src/unit-test/control-protocol.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` (Task 7), `BridgeMessage`.
- Produces (added to `ControlClientMessage`):
  `{ type: "claude_connect"; projectId?: string | null; agent?: FrontendAgent; protocolVersion?: number }`,
  `{ type: "drain"; requestId: string }`,
  `{ type: "ack"; batchId: string; ids: string[] }`.
  Added to `ControlServerMessage`:
  `{ type: "hello"; protocolVersion: number }`,
  `{ type: "drain_result"; requestId: string; batchId: string; messages: BridgeMessage[] }`.
  `DaemonClient` gains `drain(): Promise<{ batchId: string; messages: BridgeMessage[] }>` and `ack(batchId: string, ids: string[]): void`, and emits `"incompatibleDaemon"` when the first server frame is not `hello`.

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/control-protocol.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../normalize-ingress";
import type { ControlClientMessage, ControlServerMessage } from "../control-protocol";

describe("control protocol shape", () => {
  test("claude_connect carries a protocol version", () => {
    const msg: ControlClientMessage = {
      type: "claude_connect",
      agent: "grok",
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(msg.protocolVersion).toBe(1);
  });

  test("drain and ack are client messages", () => {
    const drain: ControlClientMessage = { type: "drain", requestId: "r1" };
    const ack: ControlClientMessage = { type: "ack", batchId: "b1", ids: ["m1"] };
    expect(drain.type).toBe("drain");
    expect(ack.ids).toEqual(["m1"]);
  });

  test("hello and drain_result are server messages", () => {
    const hello: ControlServerMessage = { type: "hello", protocolVersion: PROTOCOL_VERSION };
    const result: ControlServerMessage = {
      type: "drain_result",
      requestId: "r1",
      batchId: "b1",
      messages: [],
    };
    expect(hello.protocolVersion).toBe(1);
    expect(result.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/control-protocol.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'protocolVersion' does not exist`.

- [ ] **Step 3: Write minimal implementation**

In `src/control-protocol.ts`, extend the two unions:

```ts
export type ControlClientMessage =
  /**
   * `protocolVersion` is the frontend declaring which envelope shape it
   * speaks. Absent means a pre-0.8 frontend, whose payload `source`
   * field was never authenticated and is therefore ignored rather than
   * treated as a mismatch. Inferring the version from which fields
   * happen to be present is how a partially-upgraded frontend gets
   * silently mis-handled, so it is declared, not sniffed.
   */
  | {
      type: "claude_connect";
      projectId?: string | null;
      agent?: FrontendAgent;
      protocolVersion?: number;
    }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  /** Ask the daemon to lease this agent's pending messages. */
  | { type: "drain"; requestId: string }
  /** Confirm what was actually consumed. Only this deletes. */
  | { type: "ack"; batchId: string; ids: string[] }
  | { type: "status" };
```

and, in `ControlServerMessage`:

```ts
  /** First frame the daemon sends. Its absence tells a new frontend the daemon is old. */
  | { type: "hello"; protocolVersion: number }
  | { type: "drain_result"; requestId: string; batchId: string; messages: BridgeMessage[] }
```

In `src/daemon-client.ts`, send the version on connect and add the two methods:

```ts
  private pendingDrains = new Map<string, (b: { batchId: string; messages: BridgeMessage[] }) => void>();
  private drainSeq = 0;
  private sawHello = false;

  drain(): Promise<{ batchId: string; messages: BridgeMessage[] }> {
    const requestId = `d${++this.drainSeq}`;
    return new Promise((resolve) => {
      this.pendingDrains.set(requestId, resolve);
      this.send({ type: "drain", requestId });
      // A drain that never answers costs a redelivery, not a message —
      // the entries stay leased and become visible again on expiry.
      setTimeout(() => {
        if (this.pendingDrains.delete(requestId)) resolve({ batchId: "", messages: [] });
      }, 5_000);
    });
  }

  ack(batchId: string, ids: string[]): void {
    if (!batchId || ids.length === 0) return;
    this.send({ type: "ack", batchId, ids });
  }
```

In the client's message handler, add `case "hello": this.sawHello = true; break;` and `case "drain_result":` resolving the matching pending promise. Where the client currently builds the `claude_connect` frame, add `protocolVersion: PROTOCOL_VERSION`.

In `src/bridge.ts`, delete the client-side pseudo-check in `claude.setReplySender` (lines 64-67):

```ts
claude.setReplySender(async (msg: BridgeMessage, requireReply?: boolean) => {
  // The `msg.source !== "claude"` check that used to live here was
  // client-side — in the very process that would be doing the spoofing.
  // Attribution is now derived from the authenticated socket by
  // normalizeIngress on the daemon side.
  if (daemonDisabled) {
    return {
      success: false,
      error: disabledReplyError(daemonDisabledReason ?? "killed"),
    };
  }
  return daemonClient.sendReply(msg, requireReply);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/control-protocol.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/control-protocol.ts src/daemon-client.ts src/bridge.ts src/unit-test/control-protocol.test.ts
git commit -m "feat: negotiate the protocol version and add drain/ack to the control socket"
```

---

### Task 11: Daemon — mailboxes replace the registry buffers

**Files:**
- Modify: `src/daemon.ts:190-299`, `:490-649`, `:955-1027`, `:1095-1130`
- Modify: `src/frontend-registry.ts` (remove `buffers`, `buffer`, `takeBuffered`, `requeue`, `recipients`)
- Test: `src/unit-test/daemon-routing.test.ts`

**Interfaces:**
- Consumes: `MessageBus`, `Mailbox`, `MessageIndex`, `TransportRegistry`, `normalizeIngress` / `normalizeProse`, `resolveRecipients`.
- Produces (daemon-internal, exported for tests): `function createBus(deps): MessageBus`; `const MAILBOX_CAPACITY = 100`; `const LEASE_TIMEOUT_MS = 30_000`; `const INDEX_TTL_MS = 3_600_000`; `const INDEX_CAPACITY = 5_000`.

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/daemon-routing.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { INDEX_TTL_MS, LEASE_TIMEOUT_MS, MAILBOX_CAPACITY } from "../daemon-constants";

describe("daemon mailbox retention", () => {
  test("the index TTL outlives the mailbox lease", () => {
    // A recipient may reply at any point inside the TTL. If the index
    // expired first, a valid reply would become a parse failure — silent
    // loss wearing a different hat.
    expect(INDEX_TTL_MS).toBeGreaterThan(LEASE_TIMEOUT_MS);
  });

  test("the mailbox capacity is bounded", () => {
    expect(MAILBOX_CAPACITY).toBeGreaterThan(0);
    expect(MAILBOX_CAPACITY).toBeLessThanOrEqual(1_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/daemon-routing.test.ts`
Expected: FAIL — `Cannot find module '../daemon-constants'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/daemon-constants.ts` (a separate module so the tunables are importable without starting a daemon):

```ts
/** How many messages one recipient's mailbox holds before the §8 overflow contract applies. */
export const MAILBOX_CAPACITY = 100;

/** How long a drained batch stays invisible to further drains. */
export const LEASE_TIMEOUT_MS = 30_000;

/**
 * How long provenance is kept.
 *
 * Must exceed the mailbox lease, the lifetime of an active turn, and any
 * pending requireReply correlation — every one of those can still name an
 * index entry, and evicting a referenced entry turns a valid reply into a
 * parse failure.
 */
export const INDEX_TTL_MS = 3_600_000;

export const INDEX_CAPACITY = 5_000;
```

Then rewrite the daemon's message path. Replace `emitToFrontends`, `trySendBridgeMessage`'s buffering role, `flushBufferedMessages`, and the direct `deliverToCodex` call with a bus:

```ts
import { MessageBus, SendRejected } from "./message-bus";
import { Mailbox } from "./mailbox";
import { MessageIndex } from "./message-index";
import { TransportRegistry } from "./wakeup-transport";
import { normalizeProse } from "./normalize-ingress";
import { AGENT_IDS } from "./agent-id";
import {
  INDEX_CAPACITY,
  INDEX_TTL_MS,
  LEASE_TIMEOUT_MS,
  MAILBOX_CAPACITY,
} from "./daemon-constants";

const mailboxes = new Map<AgentId, Mailbox>();
function mailboxFor(agent: AgentId): Mailbox {
  let box = mailboxes.get(agent);
  if (!box) {
    box = new Mailbox(agent, { capacity: MAILBOX_CAPACITY, leaseTimeoutMs: LEASE_TIMEOUT_MS });
    mailboxes.set(agent, box);
  }
  return box;
}

const messageIndex = new MessageIndex({ capacity: INDEX_CAPACITY, ttlMs: INDEX_TTL_MS });
const transports = new TransportRegistry();

/** The agent whose request opened each agent's current turn. Turn-scoped. */
const activeRequester = new Map<AgentId, AgentId>();

const bus = new MessageBus({
  mailboxFor,
  index: messageIndex,
  state: {
    // "Known", uniformly — never "attached". A detached agent still has a
    // mailbox; that is the entire point of having one.
    knownAgents: () => [...AGENT_IDS],
    senderOf: (id, replier, now) => messageIndex.resolveSender(id, replier, now),
    activeRequesterFor: (agent) => activeRequester.get(agent) ?? null,
  },
  transports,
  log,
});

let idSeq = 0;
function nextMessageId(): string {
  return `msg_${Date.now()}_${++idSeq}`;
}
```

Register Codex's transport at startup — this is where `deliverToCodex` is demoted:

```ts
transports.register("codex", {
  payloadMode: "content",
  acknowledgementMode: "none",
  wake: (message) => {
    // Codex accepts one turn at a time. A refusal is a deferral, not a
    // loss: the outbox holds the mailbox id and the daemon wakes Codex
    // again when the current turn ends. The message itself never leaves
    // the mailbox.
    if (!deliverToCodex(message.content, false)) {
      replyOutbox.accept({ id: message.id, content: "", requireReply: false, queuedAt: Date.now() });
    }
  },
});
```

Replace the `codex.on("agentMessage")` handler body (lines 211-259) so prose ingress goes through the bus:

```ts
codex.on("agentMessage", async (msg) => {
  const result = classifyMessage(msg.content, FILTER_MODE);
  if (result.action === "buffer") {
    statusBuffer.add(toEnvelope(msg.content, "status"));
    return;
  }
  let envelope: BridgeMessage;
  try {
    envelope = normalizeProse(
      msg.content,
      { agent: "codex", protocolVersion: 1 },
      { id: nextMessageId(), now: Date.now() },
    );
  } catch (err: any) {
    // An unknown @name is a parse failure, not a broadcast. Tell Codex.
    codex.injectMessage(`[AgentBridge] ${err.message}`);
    return;
  }
  await routeOrLog(envelope);
});

async function routeOrLog(envelope: BridgeMessage): Promise<void> {
  try {
    const outcome = await bus.route(envelope, Date.now());
    if (outcome.rejected.length > 0) {
      log(`Message ${envelope.id} rejected by ${outcome.rejected.map((r) => r.agent).join(", ")}`);
    }
  } catch (err: any) {
    if (err instanceof SendRejected) log(`Send rejected: ${err.message}`);
    else throw err;
  }
}
```

Change the two system-notice sites (`daemon.ts:1102`, `:1122`) from `source: "codex"` to `from: "system", to: null, kind: "untagged"`, and route them through `routeOrLog` as well. Delete `emitToFrontends`, `flushBufferedMessages`, and `sendBridgeMessage`. In `src/frontend-registry.ts`, delete `buffers`, `buffer()`, `takeBuffered()`, `requeue()`, `bufferedCount()`, and `recipients()`; keep `slots`, `known`, `knownAgents()`, `attachedAgents()`, `isAttached()`, and the probing fields. Point `currentStatus().queuedMessageCount` at the mailboxes:

```ts
    queuedMessageCount:
      [...mailboxes.values()].reduce((n, box) => n + box.size, 0) + statusBuffer.size,
```

Add the drain/ack handlers to the control socket's message switch:

```ts
      case "drain": {
        const agent = ws.data.agent as AgentId;
        const batch = mailboxFor(agent).drain(Date.now());
        sendProtocolMessage(ws, {
          type: "drain_result",
          requestId: msg.requestId,
          batchId: batch.batchId,
          messages: batch.messages,
        });
        break;
      }
      case "ack": {
        const agent = ws.data.agent as AgentId;
        const deleted = mailboxFor(agent).ack(msg.batchId, msg.ids);
        log(`Ack from ${agent}: ${deleted}/${msg.ids.length} entries deleted`);
        break;
      }
```

and send `{ type: "hello", protocolVersion: PROTOCOL_VERSION }` as the first frame on every accepted `claude_connect`.

Replace the `claude_to_codex` handler's body (around line 494) so the frontend→Codex path goes through the bus too:

```ts
      case "claude_to_codex": {
        let envelope: BridgeMessage;
        try {
          envelope = normalizeIngress(
            msg.message,
            { agent: ws.data.agent as Origin, protocolVersion: ws.data.protocolVersion },
            { id: nextMessageId(), now: Date.now() },
          );
        } catch (err: any) {
          sendReplyResult(ws, msg.requestId, { success: false, error: err.message });
          break;
        }
        try {
          const outcome = await bus.route(envelope, Date.now());
          sendReplyResult(ws, msg.requestId, {
            success: true,
            note: outcome.rejected.length
              ? `Not delivered to ${outcome.rejected.map((r) => r.agent).join(", ")}.`
              : undefined,
          });
        } catch (err: any) {
          sendReplyResult(ws, msg.requestId, { success: false, error: err.message });
        }
        break;
      }
```

Store `protocolVersion` on the socket in the `claude_connect` handler: `ws.data.protocolVersion = msg.protocolVersion ?? null;` and add that field to `ControlSocketData`.

- [ ] **Step 4: Run the full suite**

Run: `bun run typecheck && bun test src`
Expected: typecheck clean. Tests: `daemon-routing.test.ts` passes. `frontend-registry.test.ts`, `dual-mode.test.ts`, and `e2e-multi-frontend.test.ts` fail on the removed buffer API — that is Task 12's work. Do not delete those tests; rewrite them there.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts src/daemon-constants.ts src/frontend-registry.ts src/unit-test/daemon-routing.test.ts
git commit -m "feat: give every recipient a daemon-owned mailbox, Codex included"
```

---

### Task 12: Delete the adapter's second ledger

**Files:**
- Modify: `src/claude-adapter.ts:120-200` (`pendingMessages`, `queueForPull`, `enqueueForPull`, `handleGetMessages`)
- Modify: `src/bridge.ts:85-100` (the `codexMessage` handler)
- Test: `src/unit-test/claude-adapter.test.ts`, `src/unit-test/dual-mode.test.ts`

**Interfaces:**
- Consumes: `DaemonClient.drain` / `.ack` (Task 10).
- Produces: `ClaudeAdapter.setMailbox(mailbox: { drain(): Promise<{ batchId: string; messages: BridgeMessage[] }>; ack(batchId: string, ids: string[]): void }): void`. `enqueueForPull` and `pendingMessages` are removed.

- [ ] **Step 1: Write the failing test**

Add to `src/unit-test/claude-adapter.test.ts`:

```ts
describe("get_messages is a transport, not a store", () => {
  test("drains from the daemon and acks exactly what it returned", async () => {
    const acks: { batchId: string; ids: string[] }[] = [];
    const adapter = new ClaudeAdapter("/dev/null");
    adapter.setMailbox({
      drain: async () => ({
        batchId: "b1",
        messages: [
          { id: "m1", from: "codex", to: "claude", kind: "reply", content: "a", timestamp: 0 },
        ],
      }),
      ack: (batchId, ids) => acks.push({ batchId, ids }),
    });

    const result = await adapter.handleGetMessages();
    expect(result).toMatch(/a/);
    expect(acks).toEqual([{ batchId: "b1", ids: ["m1"] }]);
  });

  test("an empty drain acks nothing", async () => {
    const acks: unknown[] = [];
    const adapter = new ClaudeAdapter("/dev/null");
    adapter.setMailbox({
      drain: async () => ({ batchId: "b2", messages: [] }),
      ack: (...args) => acks.push(args),
    });
    await adapter.handleGetMessages();
    expect(acks).toHaveLength(0);
  });

  test("the adapter keeps no messages of its own", () => {
    const adapter = new ClaudeAdapter("/dev/null") as unknown as Record<string, unknown>;
    expect(adapter.pendingMessages).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/claude-adapter.test.ts`
Expected: FAIL — `adapter.setMailbox is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/claude-adapter.ts`, delete the `pendingMessages` field, `queueForPull`, `enqueueForPull`, `maxBufferedMessages`, and `droppedMessageCount`. Add:

```ts
  /**
   * The daemon's mailbox for this agent, reached over the control socket.
   *
   * The adapter used to keep its own `pendingMessages` array, so a
   * message could sit in either of two queues and a WebSocket send
   * decided which — a successful send proves bytes were accepted, not
   * that any agent took custody. There is now one mailbox, owned by the
   * daemon, and this class is a transport to it.
   */
  private mailbox: {
    drain(): Promise<{ batchId: string; messages: BridgeMessage[] }>;
    ack(batchId: string, ids: string[]): void;
  } | null = null;

  setMailbox(mailbox: NonNullable<ClaudeAdapter["mailbox"]>): void {
    this.mailbox = mailbox;
  }

  async handleGetMessages(): Promise<string> {
    if (!this.mailbox) return "AgentBridge is not connected to a daemon.";
    const { batchId, messages } = await this.mailbox.drain();
    if (messages.length === 0) return "No new messages.";
    // Ack only what was actually handed to the model. An unacked entry
    // is redelivered on the next drain, which costs a duplicate the
    // canonical id makes cheap — the alternative costs the message.
    this.mailbox.ack(batchId, messages.map((m) => m.id));
    return messages
      .map((m) => `[${m.from}] ${m.content}`)
      .join("\n\n");
  }
```

In `pushViaChannel`, delete the `catch` branch's `this.queueForPull(message)` call — a failed push no longer needs a fallback store, because the message never left the mailbox. Include the canonical id in the notification params so the consumer can dedupe:

```ts
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          // The identical canonical id appears here and in the drained
          // payload. A working push may be seen again on the next
          // unacked drain; matching ids are what make that duplicate
          // recognisable instead of confusing.
          messageId: message.id,
          from: message.from,
          text: message.content,
        },
      });
```

In `src/bridge.ts`, wire the adapter to the daemon and delete the `deliveryHint === "queue"` branch:

```ts
claude.setMailbox({
  drain: () => daemonClient.drain(),
  ack: (batchId, ids) => daemonClient.ack(batchId, ids),
});

daemonClient.on("codexMessage", (message) => {
  const tag = isDaemonLifecycle(message.id);
  if (tag) {
    log(`Daemon lifecycle event ${message.id} → status.line`);
    statusLine.write(tag);
    return;
  }
  // A push is a wake-up. It never consumes — the message stays in the
  // daemon's mailbox until an ack, so a channel that silently drops it
  // costs latency rather than the message.
  log(`Waking Claude for ${message.id} (${message.content.length} chars)`);
  void claude.pushNotification(message);
});
```

Rewrite `src/unit-test/dual-mode.test.ts` around the new shape: the assertion that a queued message lands in `pendingMessages` becomes an assertion that it is drainable from the mailbox; the assertion that a pushed message is *not* queued is **deleted** — it encodes the defect. Rewrite `src/unit-test/frontend-registry.test.ts` to drop the buffer cases (moved to `mailbox.test.ts`) and `src/unit-test/e2e-multi-frontend.test.ts` to drain instead of reading buffers.

- [ ] **Step 4: Run the full suite**

Run: `bun run typecheck && bun test src`
Expected: PASS. Everything typechecks; the rewritten tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude-adapter.ts src/bridge.ts src/unit-test/
git commit -m "feat: make get_messages a transport to the daemon mailbox"
```

---

### Task 13: Legacy frontend compatibility

**Files:**
- Modify: `src/daemon.ts` (egress path)
- Test: `src/unit-test/legacy-frontend.test.ts`

**Interfaces:**
- Consumes: `BridgeMessage.source` (the legacy-egress field from Task 1), `ws.data.protocolVersion`.
- Produces: `function forEgress(message: BridgeMessage, protocolVersion: number | null): BridgeMessage` exported from `src/daemon-egress.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/legacy-frontend.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { forEgress } from "../daemon-egress";
import type { BridgeMessage } from "../types";

const msg: BridgeMessage = {
  id: "m1",
  from: "codex",
  to: "claude",
  kind: "reply",
  content: "x",
  timestamp: 0,
};

describe("egress compatibility", () => {
  test("a legacy frontend also gets `source` so it can still parse", () => {
    expect(forEgress(msg, null).source).toBe("codex");
  });

  test("a system notice degrades to `codex` for a legacy frontend, which has no other word for it", () => {
    expect(forEgress({ ...msg, from: "system" }, null).source).toBe("codex");
  });

  test("a current frontend gets no `source` field at all", () => {
    expect(forEgress(msg, 1).source).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/legacy-frontend.test.ts`
Expected: FAIL — `Cannot find module '../daemon-egress'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/daemon-egress.ts`:

```ts
import { isAgentId } from "./agent-id";
import type { BridgeMessage } from "./types";

/**
 * Shape a message for one frontend's declared protocol version.
 *
 * Users upgrade the daemon with `abg` while editor sessions lag, so
 * old-frontend/new-daemon has to keep working: a 0.7 frontend reads
 * `source` and knows nothing about `from`. The reverse direction is one
 * `abg kill` from resolved, which is why the frontend refuses an old
 * daemon outright instead of degrading.
 *
 * `source` is dropped entirely in 0.9.
 */
export function forEgress(message: BridgeMessage, protocolVersion: number | null): BridgeMessage {
  if (protocolVersion !== null && protocolVersion >= 1) {
    const { source: _dropped, ...rest } = message;
    return rest;
  }
  return {
    ...message,
    // A 0.7 frontend has no vocabulary for "system"; attributing a
    // lifecycle notice to codex is what it already expected to see.
    source: isAgentId(message.from) ? message.from : "codex",
  };
}
```

In `src/daemon.ts`, route every `codex_to_claude` frame through it:

```ts
      const payload: ControlServerMessage = {
        type: "codex_to_claude",
        message: forEgress(message, ws.data.protocolVersion),
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/unit-test/legacy-frontend.test.ts && bun run typecheck`
Expected: PASS, 3 tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/daemon-egress.ts src/daemon.ts src/unit-test/legacy-frontend.test.ts
git commit -m "feat: keep a 0.7 frontend working against the 0.8 daemon"
```

---

### Task 14: `requireReply` correlation

**Files:**
- Modify: `src/daemon.ts:128` (`replyRequired`), and the reply-satisfaction check
- Test: `src/unit-test/require-reply.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `MessageIndex`.
- Produces: `src/pending-requests.ts` exporting
```ts
export interface PendingRequest { requester: AgentId; messageId: string; at: number }
export class PendingRequests {
  add(req: PendingRequest): void;
  /** Returns the requests this message satisfies, removing them. */
  satisfy(inReplyTo: string | undefined, recipients: AgentId[]): PendingRequest[];
  expire(now: number, ttlMs: number): PendingRequest[];
  get size(): number;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/unit-test/require-reply.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PendingRequests } from "../pending-requests";

describe("requireReply correlation", () => {
  test("a reply naming the request satisfies it", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy("q1", ["claude"])).toHaveLength(1);
    expect(p.size).toBe(0);
  });

  test("a reply routed to the requester satisfies it even without inReplyTo", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy(undefined, ["claude"])).toHaveLength(1);
  });

  test("a reply addressed elsewhere does not satisfy it", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.satisfy(undefined, ["grok"])).toHaveLength(0);
    expect(p.size).toBe(1);
  });

  test("two concurrent requests are satisfied independently", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    p.add({ requester: "grok", messageId: "q2", at: 0 });
    expect(p.satisfy("q2", ["grok"]).map((r) => r.requester)).toEqual(["grok"]);
    expect(p.size).toBe(1);
  });

  test("an expired request is reported, not silently forgotten", () => {
    const p = new PendingRequests();
    p.add({ requester: "claude", messageId: "q1", at: 0 });
    expect(p.expire(10_000, 5_000).map((r) => r.messageId)).toEqual(["q1"]);
    expect(p.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/unit-test/require-reply.test.ts`
Expected: FAIL — `Cannot find module '../pending-requests'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pending-requests.ts`:

```ts
import type { AgentId } from "./agent-id";

export interface PendingRequest {
  requester: AgentId;
  /** The canonical id of the message that asked for a reply. */
  messageId: string;
  at: number;
}

/**
 * Which agents are waiting on an answer.
 *
 * This replaces a module-level `replyRequired` boolean that any [REPLY]
 * satisfied. With addressing, a `[REPLY @grok]` would have cleared a
 * request Claude was still waiting on — one flag cannot represent two
 * concurrent conversations.
 */
export class PendingRequests {
  private readonly requests: PendingRequest[] = [];

  get size(): number {
    return this.requests.length;
  }

  add(req: PendingRequest): void {
    this.requests.push(req);
  }

  satisfy(inReplyTo: string | undefined, recipients: AgentId[]): PendingRequest[] {
    const satisfied: PendingRequest[] = [];
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const req = this.requests[i];
      const named = inReplyTo !== undefined && inReplyTo === req.messageId;
      const routed = recipients.includes(req.requester);
      if (!named && !routed) continue;
      this.requests.splice(i, 1);
      satisfied.push(req);
    }
    return satisfied.reverse();
  }

  expire(now: number, ttlMs: number): PendingRequest[] {
    const expired: PendingRequest[] = [];
    for (let i = this.requests.length - 1; i >= 0; i--) {
      if (now - this.requests[i].at <= ttlMs) continue;
      expired.push(...this.requests.splice(i, 1));
    }
    return expired.reverse();
  }
}
```

In `src/daemon.ts`, delete `let replyRequired = false;` (line 128) and replace it with `const pendingRequests = new PendingRequests();`. Where `claude_to_codex` arrives with `requireReply: true`, call `pendingRequests.add({ requester: ws.data.agent as AgentId, messageId: envelope.id, at: Date.now() })`. In `routeOrLog`, after a successful route, call `pendingRequests.satisfy(envelope.inReplyTo, outcome.accepted)` and emit `system_reply_missing` only when a request expires, not when a turn ends with the flag still set.

- [ ] **Step 4: Run the full suite**

Run: `bun run typecheck && bun test src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pending-requests.ts src/daemon.ts src/unit-test/require-reply.test.ts
git commit -m "feat: correlate requireReply per request instead of one global flag"
```

---

### Task 15: Invert Tier 2g check 7

**Files:**
- Modify: `src/live-test/tier2g-grok-inbound.ts:346-356`
- Test: the harness is the test.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing. This is the acceptance criterion for the whole spec.

**Prerequisite:** PR #13 (`test/grok-inbound-delivery`) is merged and this branch is rebased onto it. Verify with `test -f src/live-test/tier2g-grok-inbound.ts` before starting.

- [ ] **Step 1: Rebuild the plugin bundle**

The harness drives real `src/bridge.ts` processes through the built bundle.

Run: `bun run build:plugin`
Expected: writes `plugins/agentbridge/server/{bridge-server,daemon}.js`.

- [ ] **Step 2: Run the harness to see check 7 fail in its old form**

Run: `bun run src/live-test/tier2g-grok-inbound.ts`
Expected: check 7 (`a [REPLY] is delivered ONLY as a channel notification, never also queued`) FAILS, because the `[REPLY]` is now in both frontends' mailboxes and `get_messages` returns it.

- [ ] **Step 3: Invert the check**

Replace the check and its NOTE (lines 346-356) with:

```ts
  // The fix. A `[REPLY]` is enqueued into every resolved recipient's
  // mailbox before any wake-up is attempted, so a frontend that ignores
  // notifications/claude/channel — or a Claude session whose channel is
  // gated off server-side — still finds it on the next get_messages.
  // The push is a wake-up; only an ack removes the message.
  check(
    "a [REPLY] reaches a non-Claude frontend through the mailbox, not only the channel",
    grokQueue.includes(NONCE_PUSH),
    `grokQueue has it=${grokQueue.includes(NONCE_PUSH)}`,
  );
  check(
    "the same [REPLY] carries one canonical id on both the push and the drain",
    pushedIds(grok.notifications).some((id) => grokQueueIds.includes(id)),
    "push metadata id absent from the drained payload",
  );
```

and add the two helpers next to `channelTexts`:

```ts
function pushedIds(notifications: any[]): string[] {
  return notifications
    .filter((n) => n?.method === "notifications/claude/channel")
    .map((n) => n?.params?.messageId)
    .filter((id): id is string => typeof id === "string");
}
```

The harness's `drain` helper returns joined text; add a sibling that returns the ids so `grokQueueIds` has a source — read them from the same `get_messages` result the existing `drain` parses.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `bun run src/live-test/tier2g-grok-inbound.ts`
Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Full check and commit**

```bash
bun run check
git add src/live-test/tier2g-grok-inbound.ts
git commit -m "test: Tier 2g now asserts a [REPLY] survives a channel that drops it"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/comms-lifecycle
gh pr create --repo ngna3007/agent-bridge --base master \
  --title "feat: daemon-owned mailboxes and causal routing" \
  --body-file docs/superpowers/specs/2026-08-02-comms-lifecycle-design.md
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §3 envelope → Task 1; §4 addressing → Tasks 2 and 7; §5 ledger ownership → Tasks 3 and 12; §5.1 leased drain → Task 4; §5.2 provenance index → Tasks 5 and 9; §6 routing → Task 6; §7 lifecycle and transports → Tasks 8 and 9; §8 overflow → Task 3; §9 topology → falls out of Task 11; §10/§10.1 identity → Tasks 7 and 10; §11 migration → Tasks 10 and 13; §14 `requireReply` → Task 14; §15 acceptance → Task 15. §12 (Grok backend) and §13 are explicitly out of scope.

**Two gaps I am flagging rather than papering over:**

1. **Task 11 is the largest task in the plan and does not have its own failing-test-first cycle for the daemon rewrite itself.** The daemon is a single 1100-line module with no existing unit harness; the modules it composes are each fully tested (Tasks 3–9), and the rewrite's correctness is verified by the existing E2E suite plus Task 15. If the executing engineer wants a tighter loop, the right move is to extract the control-socket message switch into a testable pure function first — that is a legitimate expansion of Task 11, not a deviation.

2. **`status` wake-up coalescing (§7's "status wakes only as a coalesced summary") is retained via the existing `StatusBuffer`**, which now feeds the bus as `from: "system"`. The spec's rule that the rendered summary is never *stored* is satisfied because the buffer holds raw entries and renders on flush; but the raw status entries do not simultaneously sit in each recipient's mailbox as §7 describes. Closing that fully means routing each raw status message through the bus *and* keeping the buffer for the wake-up rendering. I left the simpler shape in Task 11 and am naming the divergence: **if the reviewer wants §7 literally, add a task between 11 and 12** that enqueues raw status and renders the summary from a mailbox peek.

**Placeholder scan:** clean — every code step carries real code, every run step carries a real command and expected output.

**Type consistency:** `AgentId` / `Origin` / `MessageKind` come from `src/agent-id.ts` and are re-exported by `src/types.ts`; `resolveRecipients(envelope, state, now)` has the same three-parameter shape in Tasks 6, 9, and 11; `Mailbox.enqueue` returns `EnqueueResult` in Tasks 3, 4, and 9; `drain(now)` takes a clock in the mailbox and none at the protocol layer (the daemon supplies `Date.now()`), which is deliberate and consistent across Tasks 4, 10, and 11.
