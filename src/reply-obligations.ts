/**
 * Who has been promised a reply, from send until hand-off.
 *
 * `require_reply` is decided by the sender and consumed by a transport,
 * with an unbounded gap in between: `bus.route` enqueues first and wakes
 * afterwards, the wake may be deferred by a whole Codex turn, and a
 * message addressed to a Grok that is not running yet waits in the
 * mailbox until one connects. So the flag cannot ride on the send call,
 * and it cannot be dropped when the send returns.
 *
 * It used to be a bare `Set` cleared unconditionally by the sending
 * path. That is the drift this class exists to end: a wake-up is
 * best-effort by design — `TransportRegistry.wake` swallows a throw and
 * the message stays in the mailbox for a later retry — so "the send
 * returned" and "an agent was handed the message" are different events,
 * and clearing on the first one silently disarmed the second. The retry
 * then delivered a message with no reply instruction and nothing waiting
 * for an answer, which is exactly the failure `require_reply` exists to
 * prevent.
 *
 * The rule, in one place: an obligation is discharged by the transport
 * that hands the message over, released by the path that establishes
 * nobody ever will, and swept if neither happens.
 */
export class ReplyObligations {
  private readonly ids = new Map<string, number>();

  /** The sender asked for a reply to `id`. */
  require(id: string, now: number): void {
    this.ids.set(id, now);
  }

  /** Is a reply still owed for `id`? Does not consume. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * A transport handed this message to its agent. Returns whether a
   * reply was required, so the caller can act on it in the same step.
   */
  discharge(id: string): boolean {
    return this.ids.delete(id);
  }

  /**
   * This message will never be delivered — a rejected route, a dropped
   * queue entry. Nothing downstream will ever discharge it.
   */
  release(id: string): void {
    this.ids.delete(id);
  }

  /**
   * Drop obligations older than `ttlMs`, and report them.
   *
   * The backstop for the case no other path covers: a message enqueued
   * for an agent that never connects, whose mailbox entry expires
   * underneath it. Without this the entry is immortal.
   */
  sweep(now: number, ttlMs: number): string[] {
    const stale: string[] = [];
    for (const [id, at] of this.ids) {
      if (now - at > ttlMs) stale.push(id);
    }
    for (const id of stale) this.ids.delete(id);
    return stale;
  }

  get size(): number {
    return this.ids.size;
  }
}
