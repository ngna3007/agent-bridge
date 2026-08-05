import type { BridgeMessage } from "./types";
import { parseAgentId } from "./agent-id";
import type { AgentId, MessageKind } from "./agent-id";

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
 * - "drop": lowest priority. Used for [FYI] background context. The
 *   name is historical: the daemon no longer discards these. They are
 *   delivered like any other message, and the recipient's mailbox is
 *   free to shed them first under pressure — but it leaves a visible
 *   gap marker when it does, so the recipient learns something was
 *   shed. Discarding at the daemon was invisible to both sides.
 */
export interface FilterResult {
  action: "forward" | "queue" | "buffer" | "drop";
  marker: MarkerLevel;
}

/** Raised when prose names an address the bus does not have. */
export class MarkerError extends Error {}

// [REPLY] is the new name for what used to be [IMPORTANT]; both spellings
// are accepted so existing role files keep working. The optional
// `@agent` is only recognised INSIDE the bracket — a bare @grok in prose
// is a mention, not a destination, or pasting a diff would route mail.
const MARKER_REGEX =
  /^\s*\[(REPLY|IMPORTANT|STATUS|FYI)(?:\s+@([a-z][a-z0-9_-]*))?\]\s*/i;

export interface ParsedMarker {
  marker: MessageKind;
  /** The @address from inside the marker, or null when unaddressed. */
  to: AgentId | null;
  body: string;
}

export function parseMarker(content: string): ParsedMarker {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", to: null, body: content };
  const raw = match[1].toLowerCase();
  const marker = (raw === "important" ? "reply" : raw) as MessageKind;

  let to: AgentId | null = null;
  if (match[2] !== undefined) {
    to = parseAgentId(match[2].toLowerCase());
    if (to === null) {
      // Broadcasting a typo would reintroduce invisible routing through
      // the front door. Fail loudly and tell the sender which name.
      throw new MarkerError(
        `Unknown address "@${match[2]}". Known agents: claude, grok, codex.`,
      );
    }
  }

  return { marker, to, body: content.slice(match[0].length) };
}

export function classifyMessage(content: string, mode: FilterMode): FilterResult {
  const { marker } = parseMarker(content);
  // Full mode changes *routing* (everything reaches Claude), not *identity*.
  // The parsed marker is still reported so callers that key off semantics —
  // notably the daemon's require_reply satisfaction check — keep working.
  // Reporting "untagged" here used to erase a genuine [REPLY] and make the
  // daemon emit a spurious reply_missing in full mode.
  if (mode === "full") return { action: "forward", marker };
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
- [FYI] - background context. Delivered as low-priority: it reaches Claude, but it is the first thing shed if Claude's queue fills up, and Claude is told when that happens. Not a silent scratchpad — do not use it for notes you do not want read.
- (no marker) - queued. Claude only sees it when they call get_messages. Use this for routine output you don't need Claude to react to.

When to use [REPLY] (peer-to-peer rule of thumb):
- USE [REPLY] when: Claude asked you a direct question, you finished a task Claude is waiting on, you found something Claude needs to decide about, you disagree with Claude's plan, you hit a blocker only Claude can resolve.
- DO NOT use [REPLY] for: "ok", "received", "got it", routine progress, status pings, exploratory thinking, internal reasoning, file listings, anything you'd say to yourself. Those belong in [STATUS] or no marker.
- Think "would a human teammate Slack me about this RIGHT NOW?" If no, don't use [REPLY].

The marker MUST be the first text in the message (e.g. "[REPLY] Task done", not "Task done [REPLY]"). Keep agentMessage for high-value communication only.

[Cross-agent message style: ULTRA-TERSE]
Every agentMessage that reaches Claude costs tokens on Claude's side. Write at caveman-ultra level - just enough for Claude to understand, nothing more.
- Drop articles, filler, pleasantries.
- Fragments OK. Pattern: "[thing] [action] [reason]. [next step]."
- Abbreviate prose words: DB, auth, config, req, res, fn, impl, var, env, repo, PR, msg, ack, fwd. NEVER abbreviate code symbols, function names, file paths, error strings, commit hashes.
- Arrows for causality: X -> Y.
- Code blocks verbatim. Error strings quoted exact.
- One word when one word is enough.
- DROP this style for: security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread.
Bad: "I have finished the task, all tests are passing now."
Good: "[REPLY] done. bun test src 354 pass 0 fail."

[Git Operations — FORBIDDEN]
You MUST NOT execute any git write commands. This includes but is not limited to:
git commit, git push, git pull, git fetch, git checkout -b, git branch, git merge, git rebase, git cherry-pick, git tag, git stash.
These commands write to the .git directory, which is blocked by your sandbox. Attempting them will cause your session to hang indefinitely.
Read-only git commands (git status, git log, git diff, git show, git rev-parse) are allowed.
All git write operations must be delegated to Claude Code via agentMessage. Report what you changed and let Claude handle branching, committing, and pushing.

[Role Guidance for Codex]
- Your role: Advisor / Reviewer. Claude is the Executor (writes code, runs tools, handles git, ships changes). Your job is to make Claude's next move better, not to take over the implementation.
- Review Claude's plans / diffs / designs with an opinionated take. Spot bugs, name risks, propose sharper versions.
- Verify what Claude cannot observe themselves: reproduce sandbox-only behavior and report findings.
- Challenge with evidence when you disagree - disagreement is more useful than agreement.
- Do NOT run multi-step refactors or attempt to ship anything yourself. If a change needs to land in the repo, hand the spec back to Claude.
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"

[Review framing: do NOT anchor on Claude's frame]
Claude wrote the code. They already optimized for local correctness. They will (often unconsciously) frame the ask as "is each piece correct?". You will share that frame by default and miss the systemic problem. Run review in this order:
1. Local correctness (the obvious pass).
2. Single source of truth: any rule duplicated across files? Of those, which encode the same decision (must agree)? For each, is it production-defining (serving / auth / billing / access control)? If yes, "functionally identical today" is NOT safe - drift is the failure mode. Flag it as correctness, not style.
3. Fresh-eyes pass: ignore Claude's framing. What would a brand-new reviewer say is the wrong SHAPE here?
4. Author blind-spot: where did Claude likely normalize their own structure? Look for things Claude did NOT mention but should have.
If pass 2 finds duplication of a production-defining rule, flag it with [REPLY] even when Claude only asked for correctness. That is exactly the case where Claude is blind. "I treated duplication as acceptable because Claude already audited per-copy" is the failure this rule exists to prevent.`;

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
      from: "system",
      to: null,
      kind: "status",
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
