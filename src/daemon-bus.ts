/**
 * The daemon's bus block, lifted out of `daemon.ts` so it can be tested.
 *
 * `daemon.ts` binds ports at module import, so nothing in it is
 * reachable from `bun test src`. Every function here was previously
 * defined inline there and verified by reading only — which is how two
 * seam bugs (a delivery hint computed and discarded, a stale turn-scoped
 * requester) shipped past fifteen task-scoped reviews. These four
 * functions are the whole of the daemon's interaction with the bus, they
 * are the part with actual decisions in it, and they are now pure or
 * dependency-injected so a unit test can pin each decision.
 *
 * `daemon.ts` keeps the module-level state (the bus, the registry, the
 * mailbox map) and passes it in; nothing here holds state of its own.
 */

import { RoutingError } from "./routing";
import { SendRejected } from "./message-bus";
import type { RouteResult } from "./message-bus";
import type { Mailbox } from "./mailbox";
import type { TransportRegistry, WakeupTransport } from "./wakeup-transport";
import type { ClaudeDeliveryHint } from "./control-protocol";
import type { FilterMode } from "./message-filter";
import type { AgentId, BridgeMessage } from "./types";

/**
 * Whether a frontend should surface this message immediately or hold it
 * for `get_messages`. Derived from the envelope's own kind, so the
 * decision is a property of the message rather than of the call site
 * that happened to emit it.
 */
export function deliveryHintFor(message: BridgeMessage, mode: FilterMode): ClaudeDeliveryHint {
  // Filter mode decides routing, delivery mode decides transport, and
  // `full` means "forward everything" — including transport-wise. Reading
  // the hint off the envelope alone made `AGENTBRIDGE_FILTER_MODE=full`
  // plus `[STATUS]` come out as "queue", i.e. invisible until the next
  // `get_messages`, which is the opposite of what full mode promises.
  if (mode === "full") return "push";
  switch (message.kind) {
    case "reply":
      return "push";
    case "status":
    case "fyi":
      return "queue";
    case "untagged":
      // A daemon-authored lifecycle notice is the one untagged thing the
      // frontend must see at once — it is what drives the status line.
      return message.from === "system" ? "push" : "queue";
  }
}

/**
 * What happened to one send, in a shape a caller cannot half-handle.
 *
 * Deliberately a discriminated union rather than
 * `{ delivered, note?, error? }`. With optional fields, "some recipient
 * shed this message" is a field a caller can simply not read — and one
 * of three call sites did exactly that, so a `[REPLY]` could be dropped
 * for a full mailbox with the sender told nothing and one log line as
 * the only trace. `"partial"` now has to be named to be passed over, and
 * `senderFacingText` is the single place that decides what a sender is
 * owed.
 */
export type RouteOutcome =
  | { status: "delivered"; accepted: AgentId[] }
  /** Accepted by someone, shed by someone else. The sender must hear this. */
  | { status: "partial"; note: string; accepted: AgentId[] }
  /** Nobody took it. The sender must hear this. */
  | { status: "failed"; error: string };

/** What to tell the sender, or `null` when there is nothing to say. */
export function senderFacingText(outcome: RouteOutcome): string | null {
  switch (outcome.status) {
    case "delivered":
      return null;
    case "partial":
      return outcome.note;
    case "failed":
      return outcome.error;
  }
}

/** The slice of `MessageBus` the routing wrapper actually uses. */
export interface RoutableBus {
  route(envelope: BridgeMessage, now: number): Promise<RouteResult>;
}

export interface RouteDeps {
  bus: RoutableBus;
  log(message: string): void;
  /** Injected so a test can pin the routing timestamp. */
  now?(): number;
}

/**
 * The one call into the bus.
 *
 * `MessageBus.route` throws two unrelated types — `RoutingError` from
 * `resolveRecipients` and `SendRejected` from the bus itself — and a
 * caller that catches only one turns the other into an unhandled
 * rejection, i.e. a send that vanishes. Both are caught here and turned
 * into text the sender can read.
 */
export async function routeThroughBus(
  deps: RouteDeps,
  envelope: BridgeMessage,
): Promise<RouteOutcome> {
  const { bus, log } = deps;
  try {
    const outcome = await bus.route(envelope, (deps.now ?? Date.now)());
    if (outcome.rejected.length === 0) return { status: "delivered", accepted: outcome.accepted };
    log(
      `Message ${envelope.id} rejected by ${outcome.rejected.map((r) => r.agent).join(", ")}`,
    );
    return {
      status: "partial",
      note: outcome.rejected.map((r) => r.reason).join(" "),
      accepted: outcome.accepted,
    };
  } catch (err: unknown) {
    if (err instanceof RoutingError || err instanceof SendRejected) {
      log(`Message ${envelope.id} was not delivered: ${err.message}`);
      return { status: "failed", error: err.message };
    }
    // Not a delivery decision — a bug. Say so rather than reporting it
    // to the sender as a routing verdict.
    log(`Message ${envelope.id} failed to route: ${describeRouteError(err)}`);
    return { status: "failed", error: "The daemon could not route this message." };
  }
}

function describeRouteError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export interface TransportDeps {
  transports: Pick<TransportRegistry, "register">;
  mailboxFor(agent: AgentId): Pick<Mailbox, "remove">;
}

/**
 * Register a transport, self-acking it when it can never ack for itself.
 *
 * `acknowledgementMode: "none"` means no correlated evidence of
 * consumption will ever arrive, so the mailbox entry has no event that
 * could delete it — it would sit until capacity evicted it, and every
 * later send to that agent would be shed against a backlog nobody is
 * reading. Deleting on a *successful* wake is the closest honest
 * approximation: the message reached the only channel this agent has.
 *
 * Only on success. `TransportRegistry.wake` reports `"woken"` exactly
 * when the inner wake returns without throwing, so a `"failed"` wake
 * propagates and the entry stays put. A `"no-transport"` result never
 * reaches this wrapper at all.
 *
 * This is a weakening of at-least-once, confined to transports that
 * structurally cannot participate in it. Every `"explicit"` transport —
 * which is every frontend — still deletes only on a real ack.
 */
export function registerTransport(
  deps: TransportDeps,
  agent: AgentId,
  transport: WakeupTransport,
): void {
  if (transport.acknowledgementMode !== "none") {
    deps.transports.register(agent, transport);
    return;
  }
  deps.transports.register(agent, {
    ...transport,
    wake: async (message) => {
      await transport.wake(message);
      deps.mailboxFor(agent).remove([message.id]);
    },
  });
}
