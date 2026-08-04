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

  /**
   * Drop the request `messageId` opened, because the message never
   * arrived.
   *
   * Distinct from `satisfy`: nothing was answered. A request whose
   * message the app-server refused would otherwise sit until its TTL and
   * then tell the sender "no reply came" — which is true and useless,
   * because it points at Codex rather than at the send that failed. The
   * sender is told about the refusal directly instead.
   */
  cancel(messageId: string): PendingRequest | null {
    const i = this.requests.findIndex((r) => r.messageId === messageId);
    if (i === -1) return null;
    return this.requests.splice(i, 1)[0];
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
