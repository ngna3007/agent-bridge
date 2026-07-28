/**
 * Who holds the control port, and how to say so.
 *
 * The daemon used to find out by binding: `Bun.serve` threw
 * `Failed to start server. Is port 17843 in use?` from an uncaught
 * exception, which named neither the holder nor the cause. The
 * adapter's collision message — the one that says another project
 * derives the same ports and points at `abg doctor` — sat behind that,
 * in the app-server startup path the daemon never reached, so in a real
 * collision nobody ever saw it.
 *
 * Asking before binding fixes both halves: the daemon fails with the
 * right message, and the CLI can fail the same way without launching a
 * daemon it knows will die.
 */

import { connect } from "node:net";

export type ControlPortHolder =
  | { kind: "free" }
  /** An AgentBridge daemon answered /healthz. `projectId` is undefined on a pre-0.7 daemon. */
  | { kind: "agentbridge"; projectId: string | null | undefined; pid: number | null }
  /** Something is listening, but it is not one of ours. */
  | { kind: "unknown" };

/** Same cap, and the same reason, as the probes in `DaemonLifecycle`. */
const PROBE_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 500;

/**
 * Is anything accepting TCP on this port?
 *
 * Explicitly timed out rather than waiting for the OS. On a host that
 * drops SYN to closed ports instead of refusing (WSL2 behind the
 * Windows firewall), an untimed connect blocks for over two minutes
 * before reporting what a 500ms wait already tells us.
 */
function isPortListening(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Ask the control port what is on it. Never throws. */
export async function probeControlPort(port: number): Promise<ControlPortHolder> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      // `proxyUrl` is in every DaemonStatus and in nothing else likely
      // to be squatting a loopback port.
      if (body && typeof body === "object" && "proxyUrl" in body) {
        return {
          kind: "agentbridge",
          projectId: "projectId" in body ? ((body.projectId as string | null) ?? null) : undefined,
          pid: typeof body.pid === "number" ? body.pid : null,
        };
      }
    }
    return { kind: "unknown" };
  } catch {
    // No HTTP answer. Either nothing is there, or something that does
    // not speak HTTP is — and those need different messages.
    return (await isPortListening(port)) ? { kind: "unknown" } : { kind: "free" };
  }
}

/**
 * The message a user should get when the control port is taken.
 *
 * Pure, so the wording is testable without standing up a port. Says
 * what holds the port, why that happens, and the two ways out.
 */
export function describeControlPortConflict(
  port: number,
  selfProjectId: string | null,
  holder: ControlPortHolder,
): string {
  const move =
    `Set AGENTBRIDGE_CONTROL_PORT to move this project off the collision, ` +
    `or run \`abg kill\` in the other project.`;

  if (holder.kind === "agentbridge") {
    const other =
      holder.projectId === undefined
        ? "an older AgentBridge daemon that does not report its project"
        : holder.projectId === null
          ? "an AgentBridge daemon running outside any project"
          : `the AgentBridge daemon of project ${holder.projectId}`;
    const self = selfProjectId ? `Project ${selfProjectId}` : "This project";
    return (
      `Control port ${port} is already held by ${other}` +
      `${holder.pid !== null ? ` (pid ${holder.pid})` : ""}.\n` +
      `${self} derives the same port slot — project ids hash into 1000 slots, so this happens.\n` +
      `Run \`abg doctor\` to see both projects. ${move}`
    );
  }

  return (
    `Control port ${port} is already in use by a process that is not an AgentBridge daemon.\n` +
    `Stop whatever is listening on it, or ${move.charAt(0).toLowerCase()}${move.slice(1)}`
  );
}
