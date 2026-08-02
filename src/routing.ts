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
