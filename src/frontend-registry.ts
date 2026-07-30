/**
 * Who is attached to the daemon, keyed by which agent they are.
 *
 * The daemon used to hold exactly one frontend socket in a variable
 * called `attachedClaude`. That was true of the product for as long as
 * Claude was the only MCP client, and it stopped being true the moment
 * Grok Build turned out to load Claude Code's plugin registry — Grok
 * launches *our* MCP server, attaches through the same control socket,
 * and lands in the same slot Claude occupies (`docs/scaling-plan.md`
 * §4.1b). Two agents, one variable, and the loser is told "another
 * Claude session is already connected".
 *
 * This module is that variable, generalized: one slot **per agent
 * identity**, so contention is between two Claudes rather than between
 * Claude and Grok.
 *
 * It is deliberately generic over the socket and message types and
 * imports nothing. `daemon.ts` binds ports at import time and cannot be
 * unit-imported, so anything left inside it can only be tested by
 * transcribing its rules into a test file, where they drift. The rules
 * worth protecting live here instead — the same precedent
 * `pin-contract.test.ts` set.
 *
 * What stays in `daemon.ts`: liveness probing, eviction, and every
 * Codex-facing notice. Those are I/O and product copy, not bookkeeping.
 */

/** Agents that can attach *to* the bridge as a frontend. Codex is not one — it sits behind the proxy. */
export type FrontendAgent = "claude" | "grok";

export const FRONTEND_AGENTS: readonly FrontendAgent[] = ["claude", "grok"];

/**
 * What a frontend is assumed to be when it does not say.
 *
 * Every pre-0.8 frontend omits the field, and single-agent setups have
 * nothing to declare, so the absent case has to keep meaning Claude or
 * the upgrade breaks every existing session.
 */
export const DEFAULT_FRONTEND_AGENT: FrontendAgent = "claude";

/** Narrow an untrusted wire value, `null` when it is not an agent we know. */
export function parseFrontendAgent(raw: unknown): FrontendAgent | null {
  if (raw === undefined || raw === null) return DEFAULT_FRONTEND_AGENT;
  return FRONTEND_AGENTS.includes(raw as FrontendAgent) ? (raw as FrontendAgent) : null;
}

export interface FrontendRegistryOptions<S> {
  /** Cap per agent, matching the daemon's existing single-buffer cap. */
  maxBufferedMessages: number;
  /** True when the socket can still be written to. */
  isOpen: (socket: S) => boolean;
  /** True when the socket is definitively gone (not merely closing). */
  isClosed: (socket: S) => boolean;
}

export interface Occupant<S> {
  agent: FrontendAgent;
  socket: S;
}

export interface BufferResult {
  /** Oldest messages evicted to stay under the cap. Non-zero is worth logging. */
  dropped: number;
}

export class FrontendRegistry<S, M> {
  private readonly slots = new Map<FrontendAgent, S>();
  private readonly buffers = new Map<FrontendAgent, M[]>();
  /**
   * Agents seen at least once in this daemon's lifetime, plus Claude.
   *
   * Buffering is only meaningful for an agent that exists. Without this,
   * a fan-out with nobody attached would open a buffer for every agent
   * the union names and hold messages forever for one that is never
   * launched. Claude is seeded because the daemon has always buffered
   * for it before it first attaches, and losing that would change the
   * behavior of every existing single-agent session.
   */
  private readonly known = new Set<FrontendAgent>([DEFAULT_FRONTEND_AGENT]);
  private readonly probing = new Set<FrontendAgent>();

  constructor(private readonly opts: FrontendRegistryOptions<S>) {}

  /** The socket holding `agent`'s slot, if any. */
  occupant(agent: FrontendAgent): S | null {
    return this.slots.get(agent) ?? null;
  }

  /** True when `agent`'s slot is held by a socket that is still writable. */
  isAttached(agent: FrontendAgent): boolean {
    const socket = this.slots.get(agent);
    return socket !== undefined && this.opts.isOpen(socket);
  }

  /** Every currently-held agent identity, in insertion order. */
  attachedAgents(): FrontendAgent[] {
    return [...this.slots.keys()];
  }

  /** How many slots are held at all, regardless of socket health. */
  get size(): number {
    return this.slots.size;
  }

  /** Agents this daemon has served, so callers know which buffers exist. */
  knownAgents(): FrontendAgent[] {
    return [...this.known];
  }

  /**
   * Whether a contest for this agent's slot is already being decided.
   *
   * Per-agent, not global: a Claude liveness probe must not make a Grok
   * frontend wait, which is exactly the coupling this class removes.
   */
  isProbing(agent: FrontendAgent): boolean {
    return this.probing.has(agent);
  }

  beginProbe(agent: FrontendAgent): void {
    this.probing.add(agent);
  }

  endProbe(agent: FrontendAgent): void {
    this.probing.delete(agent);
  }

  /**
   * Does `socket` have to contest `agent`'s slot before taking it?
   *
   * A slot held by a socket that already reported closed is free — the
   * incumbent is gone and the daemon has simply not processed the close
   * yet. Anything else is a live incumbent the caller must probe.
   */
  contestedBy(agent: FrontendAgent, socket: S): S | null {
    const occupant = this.slots.get(agent);
    if (!occupant || occupant === socket) return null;
    return this.opts.isClosed(occupant) ? null : occupant;
  }

  /** Give `agent`'s slot to `socket`, replacing whatever held it. */
  claim(agent: FrontendAgent, socket: S): void {
    this.slots.set(agent, socket);
    this.known.add(agent);
  }

  /**
   * Release `agent`'s slot, but only if `socket` still holds it.
   *
   * The guard matters: a detach arriving after the slot was handed to a
   * replacement must not evict the replacement. Returns whether it did
   * anything, so the caller can skip the disconnect notice for a socket
   * that had already been superseded.
   */
  release(agent: FrontendAgent, socket: S): boolean {
    if (this.slots.get(agent) !== socket) return false;
    this.slots.delete(agent);
    return true;
  }

  /** Release whichever slot `socket` holds; returns the agent it was serving. */
  releaseSocket(socket: S): FrontendAgent | null {
    for (const [agent, held] of this.slots) {
      if (held === socket) {
        this.slots.delete(agent);
        return agent;
      }
    }
    return null;
  }

  /**
   * Who should receive a message from `source`.
   *
   * Only writable sockets, and never the sender — the loop-prevention
   * invariant, applied to a set instead of to a pair. A `source` that is
   * not a frontend (Codex) excludes nobody.
   */
  recipients(source?: string): Occupant<S>[] {
    const out: Occupant<S>[] = [];
    for (const [agent, socket] of this.slots) {
      if (agent === source) continue;
      if (!this.opts.isOpen(socket)) continue;
      out.push({ agent, socket });
    }
    return out;
  }

  /** Hold a message for an agent that is not currently attached. */
  buffer(agent: FrontendAgent, message: M): BufferResult {
    const queue = this.buffers.get(agent) ?? [];
    queue.push(message);
    let dropped = 0;
    if (queue.length > this.opts.maxBufferedMessages) {
      dropped = queue.length - this.opts.maxBufferedMessages;
      queue.splice(0, dropped);
    }
    this.buffers.set(agent, queue);
    this.known.add(agent);
    return { dropped };
  }

  /** Drain `agent`'s buffer for replay. The caller owns the messages after this. */
  takeBuffered(agent: FrontendAgent): M[] {
    const queue = this.buffers.get(agent);
    if (!queue || queue.length === 0) return [];
    this.buffers.set(agent, []);
    return queue;
  }

  /**
   * Put messages back at the front of `agent`'s buffer.
   *
   * Used when a replay dies partway through: the remainder has to keep
   * its place ahead of anything that arrived during the flush, or a
   * reconnect silently reorders the conversation.
   *
   * Deliberately does not enforce the cap. Trimming here could only drop
   * either the messages just rescued from a failed flush or the newest
   * arrivals, and the daemon has always let a re-buffer run over and
   * settled it on the next `buffer` call, which drops oldest-first.
   */
  requeue(agent: FrontendAgent, messages: M[]): void {
    if (messages.length === 0) return;
    const queue = this.buffers.get(agent) ?? [];
    queue.unshift(...messages);
    this.buffers.set(agent, queue);
  }

  /** Buffered count for one agent, or across all of them. */
  bufferedCount(agent?: FrontendAgent): number {
    if (agent) return this.buffers.get(agent)?.length ?? 0;
    let total = 0;
    for (const queue of this.buffers.values()) total += queue.length;
    return total;
  }
}
