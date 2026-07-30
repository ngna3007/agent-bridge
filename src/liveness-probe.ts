/**
 * Liveness probe for half-open WebSocket detection.
 *
 * Sends a WebSocket ping and waits up to `timeoutMs` for a pong. Returns true
 * if a pong frame is observed (via `pongCount` advancing past the baseline
 * snapshot). Used by challenge-on-contest admission in daemon.ts to detect
 * half-open dead peers that still report readyState=OPEN (issue #68).
 *
 * Accepts a minimal probe target interface so the loop can be unit-tested
 * against an in-memory fake without spinning up a real WebSocket.
 */

export interface ProbeTarget {
  /** WebSocket.OPEN = 1. Anything else aborts the probe. */
  readyState: number;
  /**
   * Count of pong frames observed, incremented by the caller's `pong`
   * handler and never reset. A *count* rather than a timestamp on purpose:
   * on loopback a pong can come back inside the same millisecond the probe
   * started, which `Date.now()` cannot distinguish from the probe's own
   * baseline — so a timestamped version discards the reply and declares a
   * live peer dead. An increment is unambiguous at any latency.
   */
  pongCount: number;
  /** Send a ping frame. May throw synchronously on a failed write. */
  ping(): void;
}

export interface ProbeLivenessOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const OPEN = 1;

export async function probeLiveness(
  target: ProbeTarget,
  options: ProbeLivenessOptions,
): Promise<boolean> {
  const {
    timeoutMs,
    pollMs = 50,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (target.readyState !== OPEN) return false;

  // Snapshot before pinging, so only frames that arrive from here on count.
  // Pongs already recorded — including ones from Bun's `sendPings: true`
  // heartbeat — are ignored, which is the point: a pong from before we asked
  // says nothing about whether the peer is still there now.
  const baseline = target.pongCount;
  try {
    target.ping();
  } catch {
    return false;
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (target.pongCount > baseline) return true;
    if (target.readyState !== OPEN) return false;
    await sleep(pollMs);
  }
  return target.pongCount > baseline;
}
