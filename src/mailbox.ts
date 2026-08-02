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
