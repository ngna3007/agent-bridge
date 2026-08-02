import { parseAgentId } from "./agent-id";
import { MarkerError, parseMarker } from "./message-filter";
import type { AgentId, BridgeMessage, MessageKind, Origin } from "./types";

/** Bumped when the envelope's wire shape changes. */
export const PROTOCOL_VERSION = 1;

/** Raised when an ingress payload cannot be turned into a valid envelope. */
export class IngressError extends Error {}

export interface IngressSocket {
  /** Authenticated identity of the socket this arrived on. */
  agent: Origin;
  /** null means a pre-0.8 frontend that never declared one. */
  protocolVersion: number | null;
}

export interface IngressContext {
  /** Canonical id assigned by the daemon. */
  id: string;
  now: number;
}

const KINDS: MessageKind[] = ["reply", "status", "fyi", "untagged"];

/**
 * The only writer of `from` in the system.
 *
 * Attribution comes from the authenticated socket. The previous check
 * lived in `bridge.ts` — client-side, in the very process that would be
 * doing the spoofing, which is not a check. The declared protocol
 * version decides only whether a disagreeing payload field is an error
 * (current: it promised not to send one) or noise (legacy: the field was
 * vestigial and never authenticated).
 */
export function normalizeIngress(
  raw: unknown,
  socket: IngressSocket,
  ctx: IngressContext,
): BridgeMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IngressError("Ingress payload must be an object.");
  }
  const p = raw as Record<string, unknown>;

  if (socket.protocolVersion !== null && socket.protocolVersion >= PROTOCOL_VERSION) {
    const declared = p.from ?? p.source;
    if (declared !== undefined && declared !== socket.agent) {
      throw new IngressError(
        `Payload claims from="${String(declared)}" but the socket is authenticated as "${socket.agent}".`,
      );
    }
  }

  const to = readTo(p.to);
  const kindPresent = p.kind !== undefined && p.kind !== null;
  const kind = readKind(p.kind);
  if (p.content !== undefined && typeof p.content !== "string") {
    throw new IngressError("`content` must be a string.");
  }
  if (p.inReplyTo !== undefined && typeof p.inReplyTo !== "string") {
    throw new IngressError("`inReplyTo` must be a string.");
  }
  if (p.senderRef !== undefined && typeof p.senderRef !== "string") {
    throw new IngressError("`senderRef` must be a string.");
  }
  const content = typeof p.content === "string" ? p.content : "";

  // A structured caller already said where this goes. If the text also
  // says, and says something else, there are two sources of truth for one
  // message's destination — the exact class of bug this design removes.
  // When only one side speaks (structured absent, or kind absent because
  // this is a legacy peer with no `kind` field at all), the marker's value
  // is promoted rather than treated as a conflict or discarded.
  let body = content;
  let finalTo = to;
  let finalKind = kind;
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError) throw new IngressError(err.message);
    throw err;
  }
  if (marker.marker !== "untagged" || marker.to !== null) {
    if (marker.to !== null && to !== null && marker.to !== to) {
      throw new IngressError(
        `Conflict: structured to="${to}" but the content is marked "@${marker.to}". Two sources of truth for one destination.`,
      );
    }
    if (kindPresent && marker.marker !== "untagged" && marker.marker !== kind) {
      throw new IngressError(
        `Conflict: structured kind="${kind}" but the content is marked "[${marker.marker.toUpperCase()}]".`,
      );
    }
    finalTo = to ?? marker.to;
    if (!kindPresent && marker.marker !== "untagged") finalKind = marker.marker;
    body = marker.body;
  }

  return {
    id: ctx.id,
    senderRef: typeof p.senderRef === "string" ? p.senderRef : undefined,
    from: socket.agent,
    to: finalTo,
    inReplyTo: typeof p.inReplyTo === "string" ? p.inReplyTo : undefined,
    kind: finalKind,
    content: body,
    timestamp: ctx.now,
  };
}

/** Codex has no tool. Its ordinary prose is the ingress. */
export function normalizeProse(
  content: string,
  socket: IngressSocket,
  ctx: IngressContext,
): BridgeMessage {
  let marker;
  try {
    marker = parseMarker(content);
  } catch (err) {
    if (err instanceof MarkerError) throw new IngressError(err.message);
    throw err;
  }
  return {
    id: ctx.id,
    from: socket.agent,
    to: marker.to,
    kind: marker.marker,
    content: marker.body,
    timestamp: ctx.now,
  };
}

function readTo(v: unknown): AgentId | "*" | null {
  if (v === undefined || v === null) return null;
  if (v === "*") return "*";
  if (typeof v !== "string") throw new IngressError("`to` must be a string.");
  const parsed = parseAgentId(v);
  if (parsed === null) {
    throw new IngressError(`Unknown recipient "${v}". Known agents: claude, grok, codex.`);
  }
  return parsed;
}

function readKind(v: unknown): MessageKind {
  if (v === undefined || v === null) return "untagged";
  if (typeof v === "string" && (KINDS as string[]).includes(v)) return v as MessageKind;
  throw new IngressError(`Unknown kind "${String(v)}". Expected one of ${KINDS.join(", ")}.`);
}
