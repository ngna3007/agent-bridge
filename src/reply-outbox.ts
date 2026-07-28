/**
 * Holding area for Claude→Codex messages that arrive while Codex is
 * mid-turn.
 *
 * Codex can only accept one turn at a time: `injectMessage` refuses
 * while `turnInProgress` is set. Before this module existed the refusal
 * was the whole story — the daemon returned an error and Claude had to
 * notice, remember, and retry by hand. That made "wait for ✅ Codex
 * finished before replying" a rule a human had to enforce, and it is
 * the single most common way a reply gets lost: Claude moves on, the
 * turn ends, and nobody sends the message.
 *
 * The outbox turns that refusal into a deferral. A rejected reply is
 * held, and the daemon injects it the moment the current turn
 * completes. Three properties keep the deferral honest:
 *
 * - **Bounded.** At most `max` entries. Beyond that the oldest is
 *   dropped, and the caller is told how many — a silently truncated
 *   outbox is worse than a rejection.
 * - **Perishable.** An entry older than `ttlMs` is discarded instead of
 *   delivered. A reply written against a turn that ran for half an hour
 *   is usually stale advice, and injecting it would read to Codex as a
 *   non-sequitur with no timestamp to explain it.
 * - **Single-file.** `takeNext` hands back one entry per call. Draining
 *   the whole queue at once would stack turns on Codex; one per
 *   completed turn matches how the injection actually works.
 *
 * Deliberately stores the *raw* content. Contract pinning and the
 * require-reply instruction depend on daemon state at send time (which
 * thread is active, whether that thread has seen the contract), so they
 * are applied at delivery, not when the message is queued.
 */

export interface QueuedReply {
  /** Message id from the originating BridgeMessage, for logging. */
  id: string;
  /** Undecorated message body, exactly as Claude wrote it. */
  content: string;
  requireReply: boolean;
  /** Epoch ms, used for TTL expiry. */
  queuedAt: number;
}

export interface AcceptResult {
  /** Queue depth after accepting, including this entry. */
  depth: number;
  /** Entries evicted to make room. Non-empty means the cap was hit. */
  dropped: QueuedReply[];
}

export interface TakeResult {
  /** The oldest live entry, or null when the outbox holds none. */
  reply: QueuedReply | null;
  /** Entries discarded for exceeding the TTL during this call. */
  expired: QueuedReply[];
}

export interface ReplyOutboxOptions {
  /** Maximum entries held at once. Oldest is dropped beyond this. */
  max: number;
  /** How long an entry may wait before it is considered stale. */
  ttlMs: number;
}

export class ReplyOutbox {
  private readonly entries: QueuedReply[] = [];
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(opts: ReplyOutboxOptions) {
    this.max = Math.max(1, opts.max);
    this.ttlMs = opts.ttlMs;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Configured cap, so callers can name the limit in user-facing text. */
  get capacity(): number {
    return this.max;
  }

  /** Oldest live entry without removing it. Ignores TTL. */
  peek(): QueuedReply | null {
    return this.entries[0] ?? null;
  }

  /**
   * Hold a reply for later delivery. Never rejects: when the queue is
   * full the oldest entries are evicted and returned, so the caller can
   * tell Claude what was lost rather than discovering it never arrived.
   */
  accept(reply: QueuedReply): AcceptResult {
    this.entries.push(reply);
    const dropped: QueuedReply[] = [];
    while (this.entries.length > this.max) {
      dropped.push(this.entries.shift()!);
    }
    return { depth: this.entries.length, dropped };
  }

  /**
   * Remove and return the oldest entry that is still fresh.
   *
   * Expired entries are discarded on the way, and reported separately —
   * they are the one case where the outbox loses a message on purpose,
   * so it must be visible rather than inferred from silence.
   */
  takeNext(now: number): TakeResult {
    const expired: QueuedReply[] = [];
    while (this.entries.length > 0) {
      const next = this.entries.shift()!;
      if (now - next.queuedAt > this.ttlMs) {
        expired.push(next);
        continue;
      }
      return { reply: next, expired };
    }
    return { reply: null, expired };
  }

  /**
   * Put an entry back at the front, keeping its original `queuedAt` so
   * the TTL still measures how long Claude has been waiting. Used when
   * delivery is attempted and Codex turns out to be busy again.
   */
  requeue(reply: QueuedReply): void {
    this.entries.unshift(reply);
    while (this.entries.length > this.max) {
      this.entries.pop();
    }
  }

  /**
   * Drop everything and return it. Called when the Codex side goes away
   * (app-server exit, thread gone): those messages were written for a
   * conversation that no longer exists, and delivering them into a
   * fresh thread would be worse than admitting they were dropped.
   */
  clear(): QueuedReply[] {
    return this.entries.splice(0, this.entries.length);
  }
}
