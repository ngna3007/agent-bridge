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

/**
 * Agents that can attach *to* the bridge as a frontend.
 *
 * Codex is not one — it sits behind the proxy. Neither is Grok, any
 * more: Grok was a frontend for exactly as long as the bridge could
 * only reach it through the MCP tools it inherited from Claude Code's
 * plugin registry. It is now proxied on its leader socket like Codex,
 * so the daemon speaks for it and it claims no slot.
 *
 * One member today. The registry below stays generic over the agent
 * type on purpose — per-agent slots are what stopped two different
 * agents evicting each other, and collapsing that back into a single
 * variable is the bug this module was written to remove.
 */
export type FrontendAgent = "claude";

export const FRONTEND_AGENTS: readonly FrontendAgent[] = ["claude"];

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
  /** True when the socket can still be written to. */
  isOpen: (socket: S) => boolean;
  /** True when the socket is definitively gone (not merely closing). */
  isClosed: (socket: S) => boolean;
}

export interface Occupant<S, A extends string = FrontendAgent> {
  agent: A;
  socket: S;
}

export class FrontendRegistry<S, A extends string = FrontendAgent> {
  private readonly slots = new Map<A, S>();
  /**
   * Agents seen at least once in this daemon's lifetime, plus Claude.
   *
   * A daemon-authored notice is addressed to the frontends that exist,
   * not to every name the union knows. Claude is seeded because the
   * daemon has always held messages for it before it first attaches,
   * and losing that would change the behavior of every existing
   * single-agent session.
   */
  private readonly known = new Set<A>([DEFAULT_FRONTEND_AGENT as A]);
  private readonly probing = new Set<A>();

  constructor(private readonly opts: FrontendRegistryOptions<S>) {}

  /** The socket holding `agent`'s slot, if any. */
  occupant(agent: A): S | null {
    return this.slots.get(agent) ?? null;
  }

  /** True when `agent`'s slot is held by a socket that is still writable. */
  isAttached(agent: A): boolean {
    const socket = this.slots.get(agent);
    return socket !== undefined && this.opts.isOpen(socket);
  }

  /** Every currently-held agent identity, in insertion order. */
  attachedAgents(): A[] {
    return [...this.slots.keys()];
  }

  /** How many slots are held at all, regardless of socket health. */
  get size(): number {
    return this.slots.size;
  }

  /** Agents this daemon has served, so callers know who a notice is for. */
  knownAgents(): A[] {
    return [...this.known];
  }

  /**
   * Whether a contest for this agent's slot is already being decided.
   *
   * Per-agent, not global: a Claude liveness probe must not make a Grok
   * frontend wait, which is exactly the coupling this class removes.
   */
  isProbing(agent: A): boolean {
    return this.probing.has(agent);
  }

  beginProbe(agent: A): void {
    this.probing.add(agent);
  }

  endProbe(agent: A): void {
    this.probing.delete(agent);
  }

  /**
   * Does `socket` have to contest `agent`'s slot before taking it?
   *
   * A slot held by a socket that already reported closed is free — the
   * incumbent is gone and the daemon has simply not processed the close
   * yet. Anything else is a live incumbent the caller must probe.
   */
  contestedBy(agent: A, socket: S): S | null {
    const occupant = this.slots.get(agent);
    if (!occupant || occupant === socket) return null;
    return this.opts.isClosed(occupant) ? null : occupant;
  }

  /** Give `agent`'s slot to `socket`, replacing whatever held it. */
  claim(agent: A, socket: S): void {
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
  release(agent: A, socket: S): boolean {
    if (this.slots.get(agent) !== socket) return false;
    this.slots.delete(agent);
    return true;
  }

  /** Release whichever slot `socket` holds; returns the agent it was serving. */
  releaseSocket(socket: S): A | null {
    for (const [agent, held] of this.slots) {
      if (held === socket) {
        this.slots.delete(agent);
        return agent;
      }
    }
    return null;
  }

  /**
   * Every agent whose slot is held by a socket that can still be written
   * to, in insertion order.
   *
   * Deliberately says nothing about who a message is *for*: routing is
   * `resolveRecipients`' job and lives in one place. This answers only
   * "which sockets are writable right now", which is what a wake-up
   * transport and a status broadcast need.
   */
  writable(): Occupant<S, A>[] {
    const out: Occupant<S, A>[] = [];
    for (const [agent, socket] of this.slots) {
      if (!this.opts.isOpen(socket)) continue;
      out.push({ agent, socket });
    }
    return out;
  }
}
