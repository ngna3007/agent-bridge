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

  if (isAgentId(envelope.to)) {
    if (envelope.to === envelope.from) {
      // Self-addressing is an agent bug, not a delivery case. Reject loudly
      // — same treatment as an unresolvable inReplyTo — so the sender
      // learns its marker was wrong instead of the message quietly
      // vanishing, and the no-forward-to-origin invariant holds.
      throw new RoutingError(
        `${envelope.from} addressed itself; a sender is never its own recipient`,
      );
    }
    // Same membership rule as broadcast, for the same reason. `isAgentId`
    // says the name is well-formed, not that anything answers to it, so
    // a directed send to an agent that has never connected used to be
    // accepted: a mailbox was lazily created, the entry was enqueued, the
    // wake-up failed harmlessly — and the sender was told "delivered"
    // for a message parked where nobody will ever drain it. Silent
    // shedding under a success report is worse than a refusal, so it is
    // refused. Note "known", not "attached": an agent that has connected
    // once and is mid-reconnect stays a legitimate recipient, and one
    // that connects later still drains whatever accumulated for it.
    if (!state.knownAgents().includes(envelope.to)) {
      throw new RoutingError(
        `${envelope.to} has never connected to this bridge, so it has no session to deliver to. The message was not sent.`,
      );
    }
    return [envelope.to];
  }
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
