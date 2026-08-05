/**
 * Who can be addressed on the bus.
 *
 * Deliberately not derived from `FrontendAgent`. That type answers "how
 * do you attach" — Codex sits behind the proxy and attaches through no
 * frontend slot at all, yet is a first-class recipient. Encoding
 * transport into identity is what made "everyone but the sender" look
 * like a routing rule.
 */
export type AgentId = "claude" | "grok" | "codex";

/** Who a message can be attributed to. `system` is the daemon speaking as itself. */
export type Origin = AgentId | "system";

/** Promoted out of the message text and into the protocol. */
export type MessageKind = "reply" | "status" | "fyi" | "untagged";

export const AGENT_IDS: readonly AgentId[] = ["claude", "grok", "codex"];

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

export function parseAgentId(v: string): AgentId | null {
  return isAgentId(v) ? v : null;
}

/** How an agent is named in text an agent or a human reads. */
export function agentLabel(agent: AgentId): string {
  return { claude: "Claude", grok: "Grok", codex: "Codex" }[agent];
}
