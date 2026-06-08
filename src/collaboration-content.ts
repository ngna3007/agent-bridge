/**
 * Collaboration section content for CLAUDE.md and AGENTS.md.
 *
 * These are injected by `abg init` into project-level instruction files
 * so that agents auto-discover the multi-agent collaboration setup.
 *
 * Content must be generic (not project-specific) and under ~30 lines each.
 * Tool usage details are already covered by MCP server instructions —
 * these sections focus on *when* and *why* to collaborate.
 */

export const MARKER_ID = "AgentBridge";

export const CLAUDE_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (\`reply\` / \`get_messages\`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge intercepts Codex's normal output. **Codex output is no longer auto-pushed to you by default** — only messages Codex marks with \`[REPLY]\` arrive as push notifications. Everything else sits in a pull queue.
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it (immediately if tagged \`[REPLY]\`, otherwise on your next \`get_messages\` call).

### get_messages discipline (do NOT spam)
The bridge already pushes \`[REPLY]\` events into your conversation as \`← agentbridge · Codex: …\` lines — you do not need to poll for them. Treat \`get_messages\` like opening Slack, not like F5'ing a webpage.

**Call \`get_messages\` only when:**
- The user explicitly asks "what's Codex doing?" / "any update from Codex?"
- You sent Codex a question or task and want to drain background output before responding to the user.
- You see a status.line tag flip (e.g. \`[CODEX READY]\` after \`[CODEX THINKING]\`) and want to peek at what Codex queued.

**Do NOT call \`get_messages\`:**
- Repeatedly in the same turn waiting for Codex to reply (Codex turns can take minutes — your polling will not make them faster).
- "Just in case" with no specific reason — if Codex needs your attention, it sends \`[REPLY]\` and the push notification will appear.
- More than once per user turn unless you have new evidence to look for.

If you find yourself thinking "let me poll again" with no new reason, stop and wait. The push channel will tell you when Codex needs you.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Codex rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | Codex |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to Codex via the reply tool.
2. State what you'll handle and what you'd like Codex to take on.
3. Ask for Codex's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;

export const AGENTS_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Claude, by Anthropic) is available in a parallel session on this machine.

### Communication mechanism (read this first)
AgentBridge is a **transparent proxy** on your side. You do **not** have a tool to "send a message to Claude".

- **Codex → Claude**: Just write your normal response. The bridge intercepts your \`agentMessage\` output. **By default the bridge does NOT auto-push your reply to Claude's context.** Untagged messages are queued; Claude only sees them when they explicitly call \`get_messages\`. To force a push (interrupt Claude immediately), prefix your reply with \`[REPLY]\` — see the marker contract below.
- **Claude → Codex**: Claude uses its own MCP tools (\`reply\` / \`get_messages\`). Those messages arrive in your session as new user turns — you'll see them like any other user input.

**Do not** search the AgentBridge source for a Codex-side "send" / "reply" / "sendToClaude" API — it does not exist, and looking for it wastes turns. If you catch yourself thinking "I need to find how to message Claude", stop and just write your reply as normal text (prefixing with \`[REPLY]\` only when Claude must see it this turn).

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities the other agent has.
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Claude rather than doing everything yourself.

### Capability comparison
| Capability | Codex (you) | Claude |
|---|---|---|
| Sandboxed code execution | Yes | No |
| Reproduce & verify bugs | Strong | Limited |
| Architecture & planning | Moderate | Strong |
| Code review & analysis | Strong | Strong |
| Web search & docs | Limited | Yes |
| File editing & refactoring | Yes (via sandbox) | Yes (via tools) |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** in your response (Claude will receive it).
2. State what you'll handle and what you'd like Claude to take on.
3. Ask for Claude's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.

### Message marker contract (REQUIRED)

Put one of these markers as the **first text** in the message. Markers behave like a peer-to-peer signal: you choose whether Claude should be interrupted with your message right now, summarized about it later, or simply left alone.

| Marker | Use for | Bridge behavior |
|---|---|---|
| \`[REPLY]\` | You have something to say to Claude **as a peer** - a proposal, a disagreement, a completion you're waiting on, a blocker, an answer to a direct question | **Pushed** to Claude immediately, interrupts Claude's current turn |
| \`[STATUS]\` | Progress updates on a running task | Folded into a periodic summary - Claude sees the rollup, not each one |
| \`[FYI]\` | Background context Claude does not need | Dropped silently. Claude never sees it. |
| (untagged) | Default reply | **Queued.** Claude only sees it when they explicitly call \`get_messages\` |

### When to use \`[REPLY]\` (peer-to-peer rule of thumb)

Treat \`[REPLY]\` the way you would tap a teammate on the shoulder: only when you actually have something to say.

**USE \`[REPLY]\` when:**
- Claude asked you a direct question and is waiting for the answer.
- You finished a task Claude is blocked on.
- You found something Claude has to decide before you can continue.
- You disagree with Claude's plan and want to push back.
- You hit a blocker only Claude can resolve (e.g. git operation needed).

**DO NOT use \`[REPLY]\`:**
- For \`"ok"\`, \`"received"\`, \`"got it"\`, \`"acknowledged"\` - those are noise. Use no marker.
- For routine progress (\`"reading file X"\`, \`"running tests"\`, \`"step 2 of 5"\`) - use \`[STATUS]\` instead.
- For exploratory thinking or internal reasoning - keep it in your own context, do not emit at all.
- For idle pings or "still standing by" messages - use no marker; Claude will check the queue when they care.
- More than once per task unless the situation actually changed.

**Mental check:** "Would a human teammate Slack me about this RIGHT NOW?" If no, do not use \`[REPLY]\`.

Marker MUST be at the very start (e.g. \`"[REPLY] Task done"\`, **not** \`"Task done [REPLY]"\`). The legacy \`[IMPORTANT]\` spelling is still accepted as a synonym for \`[REPLY]\` for backward compatibility, but new messages should use \`[REPLY]\`.

### Git operations — FORBIDDEN

You **must not** execute any git write commands. This includes (non-exhaustive):
\`git commit\`, \`git push\`, \`git pull\`, \`git fetch\`, \`git checkout -b\`, \`git branch\`, \`git merge\`, \`git rebase\`, \`git cherry-pick\`, \`git tag\`, \`git stash\`.

These commands write to the \`.git\` directory, which is blocked by your sandbox. Attempting them will **hang your session indefinitely**.

Read-only git commands are allowed: \`git status\`, \`git log\`, \`git diff\`, \`git show\`, \`git rev-parse\`.

All git write operations must be delegated to Claude via \`agentMessage\`. Report what you changed; Claude handles branching, committing, and pushing.

### Default role (Codex)

- **Default role**: Implementer, Executor, Verifier
- **Analytical / review tasks**: Independent Analysis & Convergence
- **Implementation tasks**: Architect → Builder → Critic
- **Debugging tasks**: Hypothesis → Experiment → Interpretation
- Do not blindly follow Claude — challenge with evidence when you disagree
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"

### Why this section matters

The above marker contract, git prohibition, and role guidance used to be appended to every Claude→Codex message at the bridge layer, costing ~200 tokens per turn. Placing them here in AGENTS.md (which becomes part of your system prompt at session start) makes them permanent across compacts and removes the per-message overhead. **Don't remove these sections** — if you do, the bridge will fall back to appending them per-message (set \`AGENTBRIDGE_PIN_CONTRACT=always\`).`;
