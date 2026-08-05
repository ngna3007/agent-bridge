import { resolveRecipients } from "./routing";
import type { RoutingState } from "./routing";
import type { Mailbox } from "./mailbox";
import type { MessageIndex } from "./message-index";
import type { TransportRegistry } from "./wakeup-transport";
import type { AgentId, BridgeMessage } from "./types";

/** The send did not happen. The sender is told, at send time. */
export class SendRejected extends Error {}

export interface RouteResult {
  id: string;
  accepted: AgentId[];
  rejected: { agent: AgentId; reason: string }[];
}

export interface BusDeps {
  mailboxFor(agent: AgentId): Mailbox;
  index: MessageIndex;
  state: RoutingState;
  transports: TransportRegistry;
  log(message: string): void;
}

/**
 * Steps 0-3 of the delivery lifecycle, in order, for every ingress.
 *
 * Every path goes through here — the `reply` tool, intercepted Codex
 * prose, and the daemon's own lifecycle notices. The previous design
 * declared the ordering non-negotiable while `claude_to_codex` bypassed
 * it entirely; a single entry point is what makes the ordering true
 * rather than merely asserted.
 */
export class MessageBus {
  constructor(private readonly deps: BusDeps) {}

  async route(
    envelope: BridgeMessage,
    now: number,
    opts: { requireReply?: boolean } = {},
  ): Promise<RouteResult> {
    // 1. the only routing decision in the system
    const recipients = resolveRecipients(envelope, this.deps.state, now);

    // The whole `require_reply` contract, in the one place that can see
    // both halves of it. The recipient count is a routing fact — `to:
    // "*"`, an omitted `to`, and a turn-scoped requester all fan out, and
    // only `resolveRecipients` knows which — so no caller can check it
    // for itself. The kind rule could be checked at ingress, and was;
    // splitting one invariant across two files meant a second bus caller
    // could route a `status` with `requireReply` and meet only half of
    // it. Ingress may still refuse earlier for a better message, but the
    // rule lives here.
    //
    // Exactly one recipient, because the obligation names one agent to
    // wait on: a sender who asked three and got one obligation has been
    // told something untrue about two of them. And `reply` only, because
    // `reply` is the one kind a full mailbox refuses — every other kind
    // sheds under pressure and still reports `accepted`, which would
    // record a reply owed for a message that no longer exists.
    if (opts.requireReply) {
      if (envelope.kind !== "reply") {
        throw new SendRejected(
          `require_reply is only available on reply-kind messages; ${envelope.id} is ${envelope.kind}. A ${envelope.kind} may be shed when a mailbox fills, which would leave the reply owed by nobody.`,
        );
      }
      if (recipients.length !== 1) {
        throw new SendRejected(
          `require_reply needs exactly one recipient; ${envelope.id} resolved to ${recipients.length} (${recipients.join(", ") || "none"}). Address one agent directly.`,
        );
      }
    }

    // 2. per-recipient acceptance. a full mailbox for A must not block B.
    const accepted: AgentId[] = [];
    const rejected: { agent: AgentId; reason: string }[] = [];
    for (const agent of recipients) {
      const result = this.deps.mailboxFor(agent).enqueue(envelope);
      if (result.accepted) accepted.push(agent);
      else rejected.push({ agent, reason: result.reason ?? "rejected" });
    }

    if (accepted.length === 0) {
      throw new SendRejected(
        rejected.length > 0
          ? rejected.map((r) => r.reason).join(" ")
          : `No recipient resolved for message ${envelope.id}.`,
      );
    }

    // Enqueue and index insertion commit as one transaction. A delivered
    // message with no provenance is one nobody can reply to, which is the
    // failure the index exists to prevent — half-committing would create it.
    const recorded = this.deps.index.record(
      envelope.id,
      { from: envelope.from, recipients: accepted, at: now },
      now,
    );
    if (!recorded) {
      this.rollback(accepted, envelope.id);
      throw new SendRejected(
        "The provenance index is full of live entries; the message was not delivered. Retry once older conversations expire.",
      );
    }

    // 3. best-effort wake-up. never consumes.
    for (const agent of accepted) {
      await this.deps.transports.wake(agent, envelope, this.deps.log);
    }

    return { id: envelope.id, accepted, rejected };
  }

  private rollback(agents: AgentId[], id: string): void {
    for (const agent of agents) this.deps.mailboxFor(agent).remove([id]);
    this.deps.log(`Rolled back ${id} from ${agents.join(", ")} — index insertion failed`);
  }
}
