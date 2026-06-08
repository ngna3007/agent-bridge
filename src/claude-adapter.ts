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
import type { BridgeMessage } from "./types";

export type ReplySender = (msg: BridgeMessage, requireReply?: boolean) => Promise<{ success: boolean; error?: string }>;
export type DeliveryMode = "push" | "pull" | "auto";

export const CLAUDE_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine.",
  "",
  "## Message delivery",
  "Codex output reaches you through one of two paths:",
  "- PUSH: a <channel source=\"agentbridge\" ...> tag appears inline in this conversation. This happens automatically when Codex marks a message with [REPLY] (the new name for [IMPORTANT]; legacy [IMPORTANT] is still accepted).",
  "- QUEUE: every untagged Codex reply, every [STATUS] summary, and any background output lives in a pull queue. You only see it when you explicitly call the get_messages tool.",
  "",
  "## get_messages discipline (do NOT spam this tool)",
  "The push path is your primary signal. Codex tagging with [REPLY] is how it asks for your attention. Treat get_messages like opening Slack, not like F5-ing a webpage.",
  "",
  "Call get_messages ONLY when one of the following is true:",
  "  1. The user asked you 'what's Codex doing?' / 'any update from Codex?'.",
  "  2. You just sent Codex a question or task AND a reasonable amount of time has passed since the last poll.",
  "  3. The status.line tag visibly changed (e.g. [CODEX READY] after [CODEX THINKING]) and you want to see the queued context.",
  "",
  "Do NOT call get_messages:",
  "  - Repeatedly in the same turn while waiting for Codex (Codex turns can take minutes; polling does not speed them up).",
  "  - 'Just in case' with no specific reason. If Codex needs your attention, it sends [REPLY] and a push notification appears.",
  "  - More than once per user turn unless something new happened to look for.",
  "",
  "If you find yourself thinking 'let me check one more time' with no new evidence, stop and wait.",
  "",
  "## Collaboration roles",
  "Default roles in this setup:",
  "- Claude: Reviewer, Planner, Hypothesis Challenger",
  "- Codex: Implementer, Executor, Reproducer/Verifier",
  "- Expect Codex to provide independent technical judgment and evidence, not passive agreement.",
  "",
  "## Thinking patterns (task-driven)",
  "- Analytical/review tasks: Independent Analysis & Convergence",
  "- Implementation tasks: Architect -> Builder -> Critic",
  "- Debugging tasks: Hypothesis -> Experiment -> Interpretation",
  "",
  "## Collaboration language",
  "- Use explicit phrases such as \"My independent view is:\", \"I agree on:\", \"I disagree on:\", and \"Current consensus:\".",
  "",
  "## Sending to Codex",
  "- Use the reply tool to send messages back to Codex - pass chat_id back.",
  "- After a reply, do NOT immediately poll get_messages. Let Codex run; its [REPLY] will arrive on the push channel when it has something to say.",
  "",
  "## Turn coordination",
  "- When you see '⏳ Codex is working', do NOT call the reply tool - wait for '✅ Codex finished'.",
  "- After Codex finishes a turn, you have an attention window to review and respond before new messages arrive.",
  "- If the reply tool returns a busy error, Codex is still executing - wait and try again later.",
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
  private pendingMessages: BridgeMessage[] = [];
  private readonly maxBufferedMessages: number;
  private droppedMessageCount = 0;

  constructor(logFile = new StateDirResolver().logFile) {
    super();
    this.logFile = logFile;
    this.instanceId = randomUUID().slice(0, 8);
    this.sessionId = `codex_${Date.now()}`;
    this.notificationIdPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
    this.log(`ClaudeAdapter created (instance=${this.instanceId})`);

    const envMode = process.env.AGENTBRIDGE_MODE as DeliveryMode | undefined;
    this.configuredMode = envMode && ["push", "pull", "auto"].includes(envMode) ? envMode : "auto";
    this.maxBufferedMessages = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);

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

  /** Returns the resolved delivery mode. */
  getDeliveryMode(): "push" | "pull" {
    return this.resolvedMode ?? "pull";
  }

  /** Returns the number of messages waiting in the pull queue. */
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
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
      // is available. If push fails, pushViaChannel already falls back to
      // queueForPull per-message.
      this.resolvedMode = "push";
      this.log("Delivery mode defaulting to push (set AGENTBRIDGE_MODE=pull to use polling instead)");
    }
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, mode=${this.resolvedMode}, msgId=${message.id}, len=${message.content.length})`);
    if (this.resolvedMode === "push") {
      await this.pushViaChannel(message);
    } else {
      this.queueForPull(message);
    }
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
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
          },
        },
      });
      this.log(`Pushed notification: ${msgId}`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      this.queueForPull(message);
    }
  }

  private queueForPull(message: BridgeMessage) {
    if (this.pendingMessages.length >= this.maxBufferedMessages) {
      this.pendingMessages.shift();
      this.droppedMessageCount++;
      this.log(`Message queue full, dropped oldest message (total dropped: ${this.droppedMessageCount})`);
    }
    this.pendingMessages.push(message);
    this.log(`Queued message for pull (${this.pendingMessages.length} pending, instance=${this.instanceId})`);
  }

  /**
   * Public entry point for delivery_hint="queue" messages: skip the
   * MCP channel and park the message in the pull queue so Claude
   * only sees it on the next get_messages call.
   */
  enqueueForPull(message: BridgeMessage) {
    this.queueForPull(message);
  }

  // ── get_messages ───────────────────────────────────────────

  private drainMessages(): { content: Array<{ type: "text"; text: string }> } {
    this.log(`get_messages called (instance=${this.instanceId}, pending=${this.pendingMessages.length}, dropped=${this.droppedMessageCount})`);
    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages from Codex." }],
      };
    }

    // Snapshot and clear atomically to avoid issues with concurrent writes
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    const dropped = this.droppedMessageCount;
    this.droppedMessageCount = 0;

    const count = messages.length;
    let header = `[${count} new message${count > 1 ? "s" : ""} from Codex]`;
    if (dropped > 0) {
      header += ` (${dropped} older message${dropped > 1 ? "s" : ""} were dropped due to queue overflow)`;
    }
    header += `\nchat_id: ${this.sessionId}`;

    const formatted = messages
      .map((msg, i) => {
        const ts = new Date(msg.timestamp).toISOString();
        return `---\n[${i + 1}] ${ts}\nCodex: ${msg.content}`;
      })
      .join("\n\n");

    this.log(`get_messages returning ${count} message(s) (instance=${this.instanceId}, dropped=${dropped})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n\n${formatted}`,
        },
      ],
    };
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
        return this.drainMessages();
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
      id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
      source: "claude",
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

    // Include pending message hint
    const pending = this.pendingMessages.length;
    let responseText = "Reply sent to Codex.";
    if (pending > 0) {
      responseText += ` Note: ${pending} unread Codex message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

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
