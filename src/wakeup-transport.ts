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

/**
 * Outcome of a wake-up attempt.
 *
 * `"no-transport"` is a configuration state — the agent was never wired
 * up, likely permanent until someone registers one. `"failed"` is a
 * transient runtime failure — the transport exists but this particular
 * call threw or rejected. Callers that want to alert on stuck
 * configuration separately from retry-worthy flakiness need these as
 * distinct values, not the same boolean.
 */
export type WakeResult = "woken" | "no-transport" | "failed";

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
  async wake(agent: AgentId, message: BridgeMessage, log: (m: string) => void): Promise<WakeResult> {
    const transport = this.transports.get(agent);
    if (!transport) {
      log(`No wake-up transport for ${agent}; ${message.id} waits in the mailbox`);
      return "no-transport";
    }
    try {
      await transport.wake(message);
      return "woken";
    } catch (err: unknown) {
      log(`Wake-up for ${agent} failed (${describeError(err)}); ${message.id} stays in the mailbox`);
      return "failed";
    }
  }
}

/**
 * `String(err)` alone degrades for non-Error throws (a plain object stringifies
 * to `[object Object]`, hiding exactly the fields — error codes, socket state —
 * that diagnostics need most). Prefer `.message` for real errors, fall back to
 * `JSON.stringify` for plain thrown values, and only fall back to `String(err)`
 * for values `JSON.stringify` itself cannot handle (e.g. throwing `undefined`
 * or a value with circular references).
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
