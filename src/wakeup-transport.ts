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
