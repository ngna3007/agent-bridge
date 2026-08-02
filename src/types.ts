// ===== Bridge Core Types =====

import type { AgentId, MessageKind, Origin } from "./agent-id";

export type { AgentId, MessageKind, Origin };

export interface BridgeMessage {
  /** Canonical, assigned by the daemon at ingress. Globally unique. */
  id: string;

  /** The sender's own id, preserved for correlation. Never used for routing. */
  senderRef?: string;

  /** Derived from the authenticated socket, never from the payload. */
  from: Origin;

  /**
   * Who this is for.
   *   AgentId — one recipient
   *   "*"     — explicit broadcast
   *   null    — unaddressed; resolved by resolveRecipients
   */
  to: AgentId | "*" | null;

  /** The message this one answers, when it answers one. Primary routing signal. */
  inReplyTo?: string;

  kind: MessageKind;

  content: string;
  timestamp: number;

  /**
   * Legacy egress only. A 0.7 frontend parses `source`, not `from`; the
   * daemon sets this when writing to such a socket and nothing reads it
   * on the way in. Dropped in 0.9.
   */
  source?: AgentId;
}

// ===== JSON-RPC 2.0 =====

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  method: string;
  id: number;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, any>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ===== MCP Tool Schema =====

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}
