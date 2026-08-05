/**
 * The slice of ACP (Agent Client Protocol) AgentBridge speaks to Grok.
 *
 * ACP is the JSON-RPC 2.0 protocol terminal coding agents standardised
 * on for editor-to-agent traffic: a client (normally an editor) opens a
 * session, sends `session/prompt`, and receives streamed `session/update`
 * notifications until the prompt's response arrives.
 *
 * AgentBridge is not an editor, and this is the one thing worth being
 * clear about: ACP has no notion of two agents talking to each other.
 * What makes the bridge possible is that Grok's *leader* — the shared
 * backend every `grok` process connects to — fans updates out to every
 * connected client and accepts prompts for a session from any of them.
 * The bridge is a second client on the human's session. Peer-to-peer
 * semantics (markers, routing, mailboxes) are entirely AgentBridge's
 * layer above this one.
 *
 * This file knows nothing about how ACP reaches the wire. On the leader
 * socket it travels inside a length-prefixed envelope — see
 * `./grok-leader-protocol`.
 *
 * Verified against grok 0.2.118. Notifications whose method starts with
 * `_x.ai/` are vendor extensions — settings, model lists, announcements
 * — and none of them are load-bearing here.
 */

/** ACP protocol version the adapter negotiates. */
export const GROK_ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC ids are numbers or strings. Ours are numbers; the TUI's are its own business. */
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * The `session/update` payloads that mean something to the bridge.
 *
 * `agent_message_chunk` is the agent's prose, streamed. `user_message_chunk`
 * is what somebody typed — including the text *we* injected, which the
 * leader echoes back to every client. Treating that echo as agent output
 * would loop a message straight back into the bus it came from.
 */
export type GrokUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "session_info_update";

export interface GrokSessionUpdate {
  sessionUpdate: GrokUpdateKind | string;
  content?: { type: string; text?: string };
}

function asObject(frame: unknown): Record<string, unknown> | null {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  return frame as Record<string, unknown>;
}

function isId(v: unknown): v is JsonRpcId {
  return typeof v === "number" || typeof v === "string";
}

/** A call awaiting an answer: it has both an id and a method. */
export function isJsonRpcRequest(frame: unknown): frame is JsonRpcRequest {
  const f = asObject(frame);
  return f !== null && typeof f.method === "string" && isId(f.id);
}

/** An answer: it has an id and carries a result or an error, but no method. */
export function isJsonRpcResponse(frame: unknown): frame is JsonRpcResponse {
  const f = asObject(frame);
  return f !== null && f.method === undefined && isId(f.id) && ("result" in f || "error" in f);
}

/** A one-way message: a method with no id to answer. */
export function isJsonRpcNotification(frame: unknown): frame is JsonRpcNotification {
  const f = asObject(frame);
  return f !== null && typeof f.method === "string" && f.id === undefined;
}

/** Text carried by an update, or null when the update carries none. */
export function updateText(update: GrokSessionUpdate | undefined): string | null {
  const text = update?.content?.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}
