/**
 * Tunables for the daemon's delivery lifecycle.
 *
 * A separate module so they can be imported — by a test, or by anything
 * that reasons about retention — without importing `daemon.ts`, which
 * binds ports and starts a Codex app-server at import time.
 */

/** How many messages one recipient's mailbox holds before the §8 overflow contract applies. */
export const MAILBOX_CAPACITY = 100;

/** How long a drained batch stays invisible to further drains. */
export const LEASE_TIMEOUT_MS = 30_000;

/**
 * How long provenance is kept.
 *
 * Must exceed the mailbox lease, the lifetime of an active turn, and any
 * pending requireReply correlation — every one of those can still name an
 * index entry, and evicting a referenced entry turns a valid reply into a
 * parse failure.
 */
export const INDEX_TTL_MS = 3_600_000;

export const INDEX_CAPACITY = 5_000;
