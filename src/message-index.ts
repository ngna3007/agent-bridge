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
