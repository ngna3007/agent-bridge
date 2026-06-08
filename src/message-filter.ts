import type { BridgeMessage } from "./types";

export type MarkerLevel = "reply" | "status" | "fyi" | "untagged";
export type FilterMode = "filtered" | "full";

/**
 * What the daemon should do with an inbound Codex agentMessage.
 *
 * - "forward": send to Claude through the MCP channel immediately
 *   (the message will land in Claude's context this turn).
 * - "queue": send to Claude but as a pull-mode item; it sits in the
 *   ClaudeAdapter's pending queue and only enters Claude's context
 *   when Claude explicitly calls the `get_messages` tool. Used for
 *   untagged Codex output so routine chatter does not auto-bloat
 *   Claude's context.
 * - "buffer": fold into the StatusBuffer summary (compressed batch
 *   flush). Used for [STATUS] progress noise.
 * - "drop": discard. Used for [FYI] background context.
 */
export interface FilterResult {
  action: "forward" | "queue" | "buffer" | "drop";
  marker: MarkerLevel;
}

// [REPLY] is the new name for what used to be [IMPORTANT]. The label
// change captures the peer-to-peer intent: Codex only marks a message
// with [REPLY] when it has something to actually *reply about* to
// Claude (a proposal, a disagreement, a completion, a blocker). The
// regex accepts both REPLY and the legacy IMPORTANT spelling so older
// AGENTS.md files keep working until the next `abg init`.
const MARKER_REGEX = /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)\]\s*/i;

export function parseMarker(content: string): { marker: MarkerLevel; body: string } {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", body: content };
  const raw = match[1].toLowerCase();
  // Map both REPLY and the legacy IMPORTANT to the same internal marker.
  const marker = (raw === "important" ? "reply" : raw) as MarkerLevel;
  return {
    marker,
    body: content.slice(match[0].length),
  };
}

export function classifyMessage(content: string, mode: FilterMode): FilterResult {
  if (mode === "full") return { action: "forward", marker: "untagged" };
  const { marker } = parseMarker(content);
  switch (marker) {
    case "reply":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      // Untagged messages go to Claude's pull queue (not pushed). The
      // assumption is Codex marks peer-to-peer output explicitly with
      // [REPLY]; everything else waits for Claude to call get_messages.
      return { action: "queue", marker };
  }
}

const BRIDGE_CONTRACT_REMINDER = `[Bridge Contract] Markers tell the bridge whether to push your message to Claude immediately or let it sit in Claude's pull queue. Put the marker as the FIRST text in the message:

- [REPLY] - you actually have something to say to Claude as a peer (a proposal, a disagreement, a completion report, a blocker, an answer to a direct question). Pushed to Claude immediately, interrupts whatever Claude is doing.
- [STATUS] - progress update for the running task. Buffered + summarized; Claude sees the summary, not each one.
- [FYI] - background context. Dropped silently.
- (no marker) - queued. Claude only sees it when they call get_messages. Use this for routine output you don't need Claude to react to.

When to use [REPLY] (peer-to-peer rule of thumb):
- USE [REPLY] when: Claude asked you a direct question, you finished a task Claude is waiting on, you found something Claude needs to decide about, you disagree with Claude's plan, you hit a blocker only Claude can resolve.
- DO NOT use [REPLY] for: "ok", "received", "got it", routine progress, status pings, exploratory thinking, internal reasoning, file listings, anything you'd say to yourself. Those belong in [STATUS] or no marker.
- Think "would a human teammate Slack me about this RIGHT NOW?" If no, don't use [REPLY].

The marker MUST be the first text in the message (e.g. "[REPLY] Task done", not "Task done [REPLY]"). Keep agentMessage for high-value communication only.

[Git Operations — FORBIDDEN]
You MUST NOT execute any git write commands. This includes but is not limited to:
git commit, git push, git pull, git fetch, git checkout -b, git branch, git merge, git rebase, git cherry-pick, git tag, git stash.
These commands write to the .git directory, which is blocked by your sandbox. Attempting them will cause your session to hang indefinitely.
Read-only git commands (git status, git log, git diff, git show, git rev-parse) are allowed.
All git write operations must be delegated to Claude Code via agentMessage. Report what you changed and let Claude handle branching, committing, and pushing.

[Role Guidance for Codex]
- Your default role: Implementer, Executor, Verifier
- Analytical/review tasks: Independent Analysis & Convergence
- Implementation tasks: Architect -> Builder -> Critic
- Debugging tasks: Hypothesis -> Experiment -> Interpretation
- Do not blindly follow Claude - challenge with evidence when you disagree
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"`;

const REPLY_REQUIRED_INSTRUCTION = `\n\n[⚠️ REPLY REQUIRED] Claude has explicitly requested a reply. You MUST send an agentMessage with the [REPLY] marker containing your response. This is a mandatory requirement - do not skip or use [STATUS]/[FYI] markers for this reply.`;

export { BRIDGE_CONTRACT_REMINDER, REPLY_REQUIRED_INSTRUCTION };

export class StatusBuffer {
  private buffer: BridgeMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushThreshold: number;
  private readonly flushTimeoutMs: number;
  private paused = false;

  constructor(
    private readonly onFlush: (summary: BridgeMessage) => void,
    options?: { flushThreshold?: number; flushTimeoutMs?: number },
  ) {
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Pause automatic flushing (threshold + timeout). Manual flush() still works. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume automatic flushing. Restarts timer if buffer has content. */
  resume(): void {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }

  add(message: BridgeMessage): void {
    this.buffer.push(message);
    if (this.paused) return; // Don't auto-flush while paused
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }

  flush(reason: string): void {
    if (this.buffer.length === 0) return;
    this.clearTimer();
    const combined = this.buffer
      .map((m) => parseMarker(m.content).body)
      .join("\n---\n");
    const summary: BridgeMessage = {
      id: `status_summary_${Date.now()}`,
      source: "codex",
      content: `[STATUS summary — ${this.buffer.length} update(s), flushed: ${reason}]\n${combined}`,
      timestamp: Date.now(),
    };
    // Clear AFTER calling onFlush — if the send fails, emitToClaude's
    // bufferedMessages fallback will still capture the summary. Clearing
    // first would lose messages when ws.send() throws on a closing socket.
    this.onFlush(summary);
    this.buffer = [];
  }

  dispose(): void {
    this.clearTimer();
    this.buffer = [];
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}
