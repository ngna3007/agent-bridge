export type BridgeDisabledReason =
  | "killed"
  | "rejected"
  | "evicted"
  | "probe_in_progress"
  | "project_mismatch"
  | "unknown_agent"
  | "auto_recovery_exhausted";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  switch (reason) {
    case "rejected":
      return "AgentBridge rejected this session — another Claude Code session is already connected. Close the other session first, or run `agentbridge kill` to reset.";
    case "evicted":
      return "AgentBridge evicted this session because it stopped responding to liveness probes — a newer Claude Code session has taken over. Close this session and start a new one with `agentbridge claude`.";
    case "probe_in_progress":
      return "AgentBridge rejected this session — a liveness probe is currently checking the incumbent Claude session. Retry in a few seconds with `agentbridge claude`.";
    case "project_mismatch":
      return "AgentBridge refused this session — the daemon on this control port belongs to a different project. Two projects have derived the same port slot. Run `agentbridge doctor` to see the collision, and `agentbridge doctor --fix` to move this project onto a free slot.";
    case "unknown_agent":
      return "AgentBridge refused this session — the daemon does not recognise the agent identity this frontend declared (`AGENTBRIDGE_AGENT`). The daemon is likely older than this frontend; restart it with `agentbridge kill` followed by `agentbridge claude`.";
    case "auto_recovery_exhausted":
      return "AgentBridge auto-recovery gave up after exhausting its retry budget for the in-flight liveness probe contention. Retry manually with `agentbridge claude`.";
    case "killed":
      return "AgentBridge is disabled by `agentbridge kill`. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.";
  }
}
