// ===== Bridge Core Types =====

import type { FrontendAgent } from "./frontend-registry";

/**
 * Who wrote a message.
 *
 * Frontends are the agents that attach to the daemon over the control
 * socket; Codex is the one that sits behind the proxy instead. Widened
 * past `"claude" | "codex"` when Grok turned out to attach through the
 * same MCP surface Claude uses (`docs/scaling-plan.md` §4.1b).
 */
export type MessageSource = FrontendAgent | "codex";

export interface BridgeMessage {
  id: string;
  source: MessageSource;
  content: string;
  timestamp: number;
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
