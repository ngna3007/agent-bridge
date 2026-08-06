/**
 * Claude Code MCP Server — Dual-Mode Message Transport
 *
 * Supports two delivery modes:
 *   - Push mode (OAuth): real-time via notifications/claude/channel
 *   - Pull mode (API key): message queue + get_messages tool
 *
 * Mode defaults to push in auto mode, or set explicitly via AGENTBRIDGE_MODE env var.
 *
 * Emits:
 *   - "ready"   ()                   — MCP connected, mode resolved
 *   - "reply"   (msg: BridgeMessage) — Claude used the reply tool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StateDirResolver } from "./state-dir";
import { getRotatingLogger } from "./log-rotator";
import { withSenderLabel } from "./sender-label";
import type { BridgeMessage } from "./types";
import type { ReplyOutcome } from "./control-protocol";

export type ReplySender = (msg: BridgeMessage, requireReply?: boolean) => Promise<ReplyOutcome>;
export type DeliveryMode = "push" | "pull" | "auto";

export const CLAUDE_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine. You and Codex are remote teammates working on the same project, not a request-response pair.",
  "",
  "## Mental model: remote async collaboration",
  "Treat Codex like a senior teammate working from another timezone over Slack and a shared repo. You don't owe Codex an instant reply on every message. You don't poll their Slack waiting for updates. You work on what's in front of you and check in when there's a reason.",
  "",
  "Concretely:",
  "- If Codex sends something that does NOT block your current work, keep working. You can answer them in five minutes, in an hour, at the end of your turn, or never if no reply adds value. Silence is a valid response.",
  "- If Codex sends something genuinely blocking (a question you need to answer to proceed, a disagreement on direction, a request for git operations), then yes, address it before continuing.",
  "- It is OK to acknowledge a Codex message briefly and keep working (\"Got the patch, I'll review after I finish the migration\"). It is also OK to say nothing.",
  "- Do not narrate to the user \"Codex sent X, should I reply?\" every time. Decide for yourself based on whether the message changes what you should do next.",
  "",
  "## Message delivery",
  "Codex output reaches you through one of two paths:",
  "- PUSH: a <channel source=\"agentbridge\" ...> tag appears inline. Codex marked the message with [REPLY] (legacy spelling [IMPORTANT] still accepted) because it wants your attention.",
  "- QUEUE: untagged replies, [STATUS] summaries, and background output live in a pull queue. You only see them when you call get_messages.",
  "",
  "## get_messages discipline (do NOT spam)",
  "The push path is your primary signal. get_messages is Slack-style pull, not an F5 loop.",
  "",
  "Call get_messages when:",
  "  - The user asks \"what's Codex doing?\" or similar.",
  "  - You just sent Codex something and a reasonable amount of time has passed.",
  "  - You see a status.line tag flip (e.g. [CODEX READY] after [CODEX THINKING]).",
  "",
  "Do NOT call get_messages:",
  "  - Repeatedly in the same turn while waiting. Codex turns take minutes; polling won't speed them up.",
  "  - \"Just in case\" with no new reason. If Codex needs you, [REPLY] will push.",
  "  - More than once per user turn without new evidence to look for.",
  "",
  "If you find yourself thinking \"let me check one more time\" with nothing new to look at, stop. Wait. Do other work.",
  "",
  "## Replying to Codex (when you do reply)",
  "- Use the reply tool. Pass chat_id back from the inbound <channel> tag.",
  "- After replying, don't immediately poll. Codex will push [REPLY] when it has something for you.",
  "- It is fine to skip replying entirely. Not every message needs a response.",
  "",
  "## Turn coordination",
  "- '⏳ Codex is working' means a turn is running. Replying anyway is safe: the bridge holds the message and injects it the moment that turn ends.",
  "- 'Reply queued for Codex' means accepted, not failed. Do NOT resend it - a resend arrives as a second copy.",
  "- After '✅ Codex finished', you have an attention window before new pushes arrive - good time to send a reply if you have one.",
  "- The queue is small and messages in it expire. If a reply is genuinely urgent, send one message rather than several.",
  "- If a queued reply is later dropped or undeliverable, AgentBridge tells you explicitly and echoes the text back. Nothing is lost silently.",
  "",
  "## Collaboration roles",
  "- Claude (you): Executor. You write the code, run the tools, drive the implementation, and handle git. The work flows through you.",
  "- Codex: Advisor / Reviewer. Senior teammate whose job is to review your plans, challenge your assumptions, run independent verification in their sandbox, and give second-opinion calls. Codex does NOT ship the change; you do.",
  "- Treat Codex like a senior consulting engineer on the team: ask for their take on hard design calls, send them code to review, run a tricky scenario by them when you're unsure. Most of the time you proceed without consulting them.",
  "- Default to executing yourself. Only loop Codex in when (a) the call is non-obvious and a second opinion would change the decision, (b) you're about to do something potentially expensive or hard to reverse, or (c) you need their sandbox to verify a runtime behavior you can't observe.",
  "",
  "## Thinking patterns (task-driven)",
  "- Implementation tasks (your default): plan -> execute -> self-review. Loop in Codex only if a step is genuinely uncertain.",
  "- Analytical / review tasks: do your own pass first, then optionally send to Codex for an independent angle.",
  "- Debugging tasks: form your own hypothesis, test it. If you stall, ask Codex to reproduce in their sandbox.",
  "",
  "## Collaboration language",
  "When you do involve Codex, use explicit phrases so the exchange stays unambiguous: \"My current take is:\", \"I'd like your independent view on:\", \"I agree on:\", \"I disagree on:\", \"Current consensus:\".",
  "",
  "## Requesting review from Codex (counter your author blind spot)",
  "When you send Codex a diff or plan, you also wrote it. You will have normalized your own structure and Codex will tend to anchor on the frame you give them. To get a real second perspective, do not frame the ask as 'is each piece correct?'. Frame it as 'review correctness AND structure / shape / invariants.' Do not pre-narrate your own correctness audit; telling Codex 'I already checked X, Y, Z' anchors them on per-copy correctness. Explicitly ask for the single-source-of-truth pass for any production-defining logic (serving, authorization, billing, access control). Sample phrasing: \"review correctness AND single-source. is any production-defining rule duplicated across files?\"",
  "",
  "If Codex's first review only addresses local correctness, push back once: \"any duplicated invariants you would single-source? fresh-eyes pass please.\" This is the single most useful bridge follow-up - a real failure mode is two AI reviewers converging on per-copy correctness and missing that a rule is defined in 4 places. \"Functionally identical today\" is not safe for production-defining duplication; drift is the failure mode.",
  "",
  "## Cross-agent message style: ULTRA-TERSE",
  "Messages crossing the bridge cost tokens on both sides. Write them at caveman ultra level - just enough for Codex to understand, nothing more. This rule applies ONLY to messages sent via the reply tool; your user-facing text stays in your normal register.",
  "",
  "Rules for cross-agent messages:",
  "- Drop articles (a / an / the), filler (just, really, basically, actually), pleasantries (thanks, please, happy to).",
  "- Fragments OK. Pattern: \"[thing] [action] [reason]. [next step].\"",
  "- Abbreviate prose words: DB, auth, config, req, res, fn, impl, var, env, repo, PR, msg, ack, fwd. NEVER abbreviate code symbols, function names, file paths, error strings, commit hashes.",
  "- Use arrows for causality: X -> Y.",
  "- Code blocks stay verbatim. Errors quoted exact.",
  "- One word when one word is enough.",
  "- DROP this style for: security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread. Use normal prose for those.",
  "",
  "Examples (style of YOUR messages to Codex):",
  "- BAD:  \"Hi Codex, I was wondering if you could take a look at the authentication middleware - I suspect there might be an issue with the token expiry check, possibly using < instead of <=. Thanks!\"",
  "- GOOD: \"auth middleware bug. token expiry check `<` not `<=`. file: src/auth/token.ts:42. confirm in your sandbox?\"",
  "",
  "- BAD:  \"Could you please run the test suite and let me know if it passes?\"",
  "- GOOD: \"run `bun test src`. report pass/fail count.\"",
  "",
  "- BAD:  \"I've decided to go with approach A, do you agree?\"",
  "- GOOD: \"plan: approach A (single transaction, idempotent). disagree?\"",
].join("\n");

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private sessionId: string;
  private readonly notificationIdPrefix: string;
  private readonly instanceId: string;
  private replySender: ReplySender | null = null;
  private readonly logFile: string;

  // Dual-mode transport
  private readonly configuredMode: DeliveryMode;
  private resolvedMode: "push" | "pull" | null = null;

  /**
   * The daemon's mailbox for this agent, reached over the control socket.
   *
   * The adapter used to keep its own `pendingMessages` array, so a
   * message could sit in either of two queues and a WebSocket send
   * decided which — a successful send proves bytes were accepted, not
   * that any agent took custody. There is now one mailbox, owned by the
   * daemon, and this class is a transport to it.
   */
  private mailbox: {
    drain(): Promise<{ batchId: string; messages: BridgeMessage[] }>;
    ack(batchId: string, ids: string[]): void;
  } | null = null;

  constructor(logFile = new StateDirResolver().logFile) {
    super();
    this.logFile = logFile;
    this.instanceId = randomUUID().slice(0, 8);
    this.sessionId = `codex_${Date.now()}`;
    this.notificationIdPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
    this.log(`ClaudeAdapter created (instance=${this.instanceId})`);

    const envMode = process.env.AGENTBRIDGE_MODE as DeliveryMode | undefined;
    this.configuredMode = envMode && ["push", "pull", "auto"].includes(envMode) ? envMode : "auto";

    this.server = new Server(
      { name: "agentbridge", version: "0.1.0" },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        instructions: CLAUDE_INSTRUCTIONS,
      },
    );

    this.setupHandlers();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start() {
    const transport = new StdioServerTransport();
    this.resolveMode();
    await this.server.connect(transport);
    this.log(`MCP server connected (mode: ${this.resolvedMode})`);
    this.emit("ready");
  }

  /** Register the async sender that bridge provides for reply delivery. */
  setReplySender(sender: ReplySender) {
    this.replySender = sender;
  }

  setMailbox(mailbox: NonNullable<ClaudeAdapter["mailbox"]>): void {
    this.mailbox = mailbox;
  }

  /** Returns the resolved delivery mode. */
  getDeliveryMode(): "push" | "pull" {
    return this.resolvedMode ?? "pull";
  }

  // ── Mode Detection ─────────────────────────────────────────

  private resolveMode(): void {
    if (this.resolvedMode) return;

    if (this.configuredMode === "push" || this.configuredMode === "pull") {
      this.resolvedMode = this.configuredMode;
      this.log(`Delivery mode set by AGENTBRIDGE_MODE: ${this.resolvedMode}`);
    } else {
      // Default to push — AgentBridge always runs as a Claude Code plugin
      // with --dangerously-load-development-channels, so channel delivery
      // is available. A failed push no longer needs a fallback store: the
      // message never left the daemon's mailbox, so Claude reaches it on
      // the next get_messages instead.
      this.resolvedMode = "push";
      this.log("Delivery mode defaulting to push (set AGENTBRIDGE_MODE=pull to use polling instead)");
    }
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, mode=${this.resolvedMode}, msgId=${message.id}, len=${message.content.length})`);
    if (this.resolvedMode === "push") {
      await this.pushViaChannel(message);
    }
    // In pull mode there is nothing else to do here: the message already
    // lives in the daemon's mailbox, and Claude reaches it by calling
    // get_messages, which drains the mailbox directly.
  }

  private async pushViaChannel(message: BridgeMessage) {
    const msgId = `codex_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.content,
          meta: {
            chat_id: this.sessionId,
            message_id: msgId,
            // The daemon-assigned canonical id, attached so the host layer
            // can correlate this push with its origin. The drain path
            // (`handleGetMessages` below) does not currently surface any
            // id in its output, so a consumer has no id-based way to
            // recognise this push against a later unacked drain of the
            // same message. A redelivered duplicate is an accepted cost
            // of at-least-once delivery, not a bug this id closes.
            canonical_id: message.id,
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
          },
        },
      });
      this.log(`Pushed notification: ${msgId} (canonical=${message.id})`);
    } catch (e: any) {
      // A push is a wake-up, not the delivery: a successful send proves
      // only that bytes were accepted, not that any agent took custody.
      // The message never left the daemon's mailbox, so a failed send
      // costs latency (redelivered on the next drain / lease expiry),
      // not the message — there is no second store to fall back to.
      this.log(`Push notification failed, message stays in mailbox: ${e.message}`);
    }
  }

  // ── get_messages ───────────────────────────────────────────

  /**
   * `get_messages` is a transport to the daemon's mailbox, not a store.
   * Every drained message is acked immediately before returning — an
   * unacked entry is redelivered once its lease expires, which costs a
   * duplicate the canonical id makes cheap to recognise. There is no
   * "ack only after the model confirms" step; no such signal exists.
   */
  async handleGetMessages(): Promise<string> {
    this.log(`get_messages called (instance=${this.instanceId})`);
    if (!this.mailbox) return "AgentBridge is not connected to a daemon.";
    const { batchId, messages } = await this.mailbox.drain();
    if (messages.length === 0) return "No new messages.";
    this.mailbox.ack(batchId, messages.map((m) => m.id));
    this.log(`get_messages returning ${messages.length} message(s) (instance=${this.instanceId})`);
    return messages.map(withSenderLabel).join("\n\n");
  }

  // ── MCP Tool Handlers ─────────────────────────────────────

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description:
            "Send a message back to Codex. Your reply will be injected into the Codex session as a new user turn.",
          inputSchema: {
            type: "object" as const,
            properties: {
              chat_id: {
                type: "string",
                description: "The conversation to reply in (from the inbound <channel> tag).",
              },
              text: {
                type: "string",
                description: "The message to send to Codex.",
              },
              require_reply: {
                type: "boolean",
                description: "When true, Codex is required to send a reply. All Codex messages from this turn will be forwarded immediately (bypassing STATUS buffering). Use this when you need a direct answer from Codex.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_messages",
          description:
            "Check for new messages from Codex. Call this after sending a reply or when you expect a response from Codex.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "reply") {
        return this.handleReply(args as Record<string, unknown>);
      }

      if (name === "get_messages") {
        const text = await this.handleGetMessages();
        return { content: [{ type: "text" as const, text }] };
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
  }

  private async handleReply(args: Record<string, unknown>) {
    const text = args?.text as string | undefined;
    if (!text) {
      return {
        content: [{ type: "text" as const, text: "Error: missing required parameter 'text'" }],
        isError: true,
      };
    }

    const requireReply = args?.require_reply === true;

    const bridgeMsg: BridgeMessage = {
      // Overwritten by the daemon at ingress (`normalizeIngress` assigns
      // the canonical id); this value is never read back.
      id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
      from: "claude",
      to: "codex",
      kind: "reply",
      content: text,
      timestamp: Date.now(),
    };

    if (!this.replySender) {
      this.log("No reply sender registered");
      return {
        content: [{ type: "text" as const, text: "Error: bridge not initialized, cannot send reply." }],
        isError: true,
      };
    }

    const result = await this.replySender(bridgeMsg, requireReply);
    if (!result.success) {
      this.log(`Reply delivery failed: ${result.error}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    // A queued reply is a success with a delay, not an error. Saying
    // "sent" would be a lie Claude cannot detect, and returning an
    // error would provoke the manual retry the outbox exists to remove.
    //
    // There used to be an "N unread messages waiting" hint here, sourced
    // from the adapter's own pull queue. That queue is gone \u2014 the daemon's
    // mailbox is the only store now, and peeking its depth would mean
    // draining it, which would ack messages Claude never asked to read.
    const responseText = result.queued
      ? `Reply queued for Codex. ${result.note ?? "Codex is mid-turn; it will be delivered when the turn ends."} You do not need to resend it.`
      : "Reply sent to Codex.";

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] [ClaudeAdapter] ${msg}\n`;
    process.stderr.write(line);
    getRotatingLogger(this.logFile).write(line);
  }
}
