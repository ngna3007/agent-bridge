import { isAgentId } from "./agent-id";
import { REPLY_REQUIRED_INSTRUCTION } from "./message-filter";
import type { ReplyObligations } from "./reply-obligations";
import type { GrokInjectionCorrelation } from "./grok-adapter";
import type { AgentId, BridgeMessage } from "./types";
import type { WakeupTransport } from "./wakeup-transport";

export interface GrokWakeDeps {
  /** Who is still owed a reply. The one place that answer lives. */
  obligations: ReplyObligations;
  /** Put a prompt on the wire. False means there is no live session. */
  inject(content: string, correlation: GrokInjectionCorrelation): boolean;
  /** Record that `requester` is waiting on Grok's answer to `messageId`. */
  expectReply(requester: AgentId, messageId: string): void;
  log(msg: string): void;
}

/**
 * Grok's wake-up: prompt the session the human's TUI is working in.
 *
 * Deliberately without the outbox Codex needs. A second `turn/start`
 * mid-turn is an error on Codex's app-server, so the daemon has to hold
 * the message and re-inject at the boundary; Grok's leader queues the
 * prompt and runs it at the next boundary itself. Re-implementing that
 * here would be a worse copy of something the server already does.
 *
 * The only refusal left is "there is no session yet" — no TUI has come
 * through the proxy. That throws, which leaves the message in the
 * mailbox for `drainGrokBacklog` to deliver when one arrives.
 *
 * Its own module, rather than an inline object in the daemon, because
 * the interesting behaviour is the failure: a wake that throws must
 * leave the reply obligation exactly as it found it, or the retry
 * delivers a message with no reply instruction and nothing waiting for
 * an answer. That is a property worth a test, and a daemon that opens
 * sockets on import cannot be given one.
 */
export function grokWakeTransport(deps: GrokWakeDeps): WakeupTransport {
  return {
    payloadMode: "content",
    acknowledgementMode: "none",
    wake: (message: BridgeMessage) => {
      // Read, don't consume. This wake is the one that can fail *and*
      // keep the message: no session means a throw, and the mailbox
      // holds the entry for `drainGrokBacklog` to retry. Discharging
      // here would have that retry deliver the message with no reply
      // instruction and no pending request — the sender was told a reply
      // was required, and nothing in the system would be waiting for
      // one. The Codex transport can discharge on entry because its
      // deferral hands the obligation to an outbox entry; this one has
      // nowhere to hand it but here.
      const requireReply = deps.obligations.has(message.id);
      const requester = isAgentId(message.from) ? message.from : "system";
      const content = requireReply
        ? message.content + REPLY_REQUIRED_INSTRUCTION
        : message.content;
      // The correlation carries `message.content`, not `content`: the
      // echo a rejection notice shows the sender should be what they
      // wrote, not the instruction the daemon stapled to it.
      const accepted = deps.inject(content, {
        messageId: message.id,
        requester,
        text: message.content,
      });
      if (!accepted) throw new Error("Grok has no live session to inject into");
      // Discharged only now that the prompt is on the wire.
      deps.obligations.discharge(message.id);

      // Deliberately no `activeRequester` here. Grok's leader queues an
      // injected prompt and runs it at the *next* turn boundary, so the
      // human's turn may still be running — and its `turnCompleted`
      // would clear the requester before the injected turn ever started.
      // The adapter reports ownership per turn instead (`respondingTo`),
      // and the daemon sets it when the answer arrives.
      if (requireReply && isAgentId(message.from)) {
        deps.expectReply(message.from, message.id);
        deps.log(`Reply required from Grok for ${message.id} (requester: ${message.from})`);
      }
    },
  };
}
