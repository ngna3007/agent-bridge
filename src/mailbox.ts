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
        // A capacity-1 (or 0) mailbox has no room for both a gap entry
        // and the incoming message. Skip the gap entry: drop the oldest
        // and let it surface as an ordinary gap marker through
        // unreportedDrops on the next drain instead.
        if (this.opts.capacity < 2) {
          this.dropOldestFree();
          this.push(message);
          return { accepted: true };
        }
        // Collapse the oldest raw status entries into one gap entry that
        // is itself an ordinary entry with its own id. Status keeps a
        // single representation: raw entries, never a stored summary.
        // The gap entry stands in for the elided entries, so it is
        // inserted where they were — at the front — not appended.
        const collapsed = this.collapseOldest("status");
        this.pushFront({
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

  /**
   * Lease every free entry to one batch.
   *
   * A lease hides its entries from further drains for `leaseTimeoutMs`,
   * so a retry does not re-serve in-flight work, and makes them visible
   * again on expiry, so a drain response that never arrives costs a
   * redelivery rather than the message. This is at-least-once by
   * construction; the canonical `id` is what makes the duplicate cheap.
   *
   * A pending gap marker is prepended, not appended: storage order is
   * already the correct drain order (gap entries stand in for the
   * elided *oldest* entries and are stored at index 0), so drain is a
   * straight pass-through of storage order.
   */
  drain(now: number): DrainBatch {
    const batchId = `${this.agent}_b${++this.batchSeq}_${now}`;
    const gap = this.takeGapMarker(now);
    if (gap) this.pushFront(gap);

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

  private push(message: BridgeMessage): void {
    this.entries.push({ message, leasedBy: null, leaseExpiresAt: 0 });
  }

  private pushFront(message: BridgeMessage): void {
    this.entries.unshift({ message, leasedBy: null, leaseExpiresAt: 0 });
  }

  /**
   * Remove entries of one kind until two slots are free — one for the
   * gap entry, one for the incoming message. When same-kind victims run
   * out before that, fall back to the oldest free entry of any kind so
   * the loop always makes progress toward those two free slots. Returns
   * how many entries were removed in total. Callers with capacity < 2
   * must not call this — see the capacity guard in `enqueue`.
   */
  private collapseOldest(kind: MessageKind): number {
    let removed = 0;
    while (this.entries.length > this.opts.capacity - 2) {
      const idx = this.entries.findIndex((e) => e.message.kind === kind);
      if (idx === -1) {
        this.dropOldestFree();
        removed++;
        continue;
      }
      this.entries.splice(idx, 1);
      removed++;
      this.dropped[kind]++;
    }
    return removed;
  }

  // Evicts the globally oldest unleased entry, not the oldest entry of
  // any particular kind — a mailbox is one recipient's single ordered
  // queue, and "oldest" means oldest overall across all kinds.
  private dropOldestFree(): void {
    const idx = this.entries.findIndex((e) => e.leasedBy === null);
    const victim = this.entries.splice(idx === -1 ? 0 : idx, 1)[0];
    if (victim) {
      this.dropped[victim.message.kind]++;
      this.unreportedDrops++;
    }
  }

  /** Gap entry owed to the recipient, consumed by `drain`. */
  private takeGapMarker(now: number): BridgeMessage | null {
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
