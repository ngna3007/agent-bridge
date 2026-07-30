# Proposal v5.2 — Per-Agent-Type Role Customization + Test Plan

Status: **proposal, not approved.** Revised after Codex review rounds 1–4.
Date: 2026-07-27
Repo: `agent-bridge/` @ `4ac0d88`, branch `docs/english-only`, package `0.6.8`
(base `master` @ `b92a924`; PRs #1 `b825907`, #2 `e98c6c2`, #3 `4ac0d88` all open, all off `master`)
Author: Claude · Reviewer: Codex (rounds 1–4 complete; all blocking findings accepted)
Companion: `docs/scaling-plan.md`

## Changelog v5.1 → v5.2

**One design change, user-directed.** The authoring surface moves from
`.agentbridge/roles.json` + `customFile` pointers to a single
`.agentbridge/roles.md` with `## <agent>` blocks (§7). This answers the surface
question the user parked ("md, json, or in the TUI?") in favor of Markdown, and
deletes the read-source half of the round-3 path correction — with no
`customFile` string to resolve, the traversal and broken-pointer error classes
stop existing. The write-target half is untouched. §9's error table and §12's
feature tests are restated against the new grammar; the empty-block hard error
carries over the intent of the old broken-pointer rule.

**Needs a Codex round-5 pass** on §7 specifically: the grammar is new, and the
"preset line is the *whole* body or it is prose" rule is the kind of thing that
looks obvious in a spec and ambiguous in an implementation.

## Changelog v5 → v5.1

No design changes. The live bug logged in v3 is fixed and shipped as
[PR #2](https://github.com/ngna3007/agent-bridge/pull/2); §11 restaged from four
rows to five (the bug fix split out of the `MARKER_SPEC` PR); round-5 Q1 answered
by doing it; two feature-test rows marked already-shipped.

## Changelog v4 → v5

| # | Round-4 finding | Resolution |
|---|---|---|
| 1 | Surfaces are not just projections — lifecycle and budget differ | Surface model is **projection + lifecycle + budget**. §2 |
| 2 | "Bounded" needs enforcement | Hard directive budgets, registered and golden-tested. §5 |
| 3 | Invariant still false under `PIN_CONTRACT=always` | Legacy opt-in stated as an explicit, measured, warned exception. §5 |
| 4 | Reconciliation needs a launch-time check | Launch **validates** fingerprints, warns with a repair command, never mutates. §6 |
| 5 | Runtime capability section is dead weight in the envelope | **Removed from the init-time envelope.** Capability model kept for launch diagnostics and human-facing warnings only. §3 |
| 6 | Missing-assignment vs broken-pointer distinction | Confirmed correct; no change. |
| 7 | Proposal bundles seven changes | **Staged into PRs.** §11 |

**PR 1 is merged-ready and open:** `fix/codex-role-contradiction` → `b825907` →
[PR #1](https://github.com/ngna3007/agent-bridge/pull/1), independently verified
by Codex (typecheck clean, focused 52/0, plugin-sync clean, two-file scope,
`AGENTS_MD_SECTION` 11,207 confirmed, no other issues).

Scope, from the user: **role text only.** `role:` is a label plus prose; the bridge
does not read it as a routing directive. Routing topology and event triggers are
out of scope.

## Changelog v3 → v4

All four round-3 blockers verified against source and **accepted**:

| # | Finding | Verification | Resolution |
|---|---|---|---|
| 1 | `MARKER_SPEC` cannot hold one unconditional mapping | `message-filter.ts:45` — full mode forwards everything; `AGENTBRIDGE_FILTER_MODE` at `daemon.ts:52-53` | Three-layer spec: identity / routing-by-filter-mode / delivery-by-transport-mode. §2 |
| 2 | Surfaces need **projections**, not identical mappings | `REPLY_REQUIRED_INSTRUCTION` names only `[REPLY]` — cannot express the full table | Declared projections + generated fragment + mutation test. §2 |
| 3 | "Nothing per-message" is **false** | `daemon.ts:382-383` appends `REPLY_REQUIRED_INSTRUCTION` whenever `require_reply` | Invariant rewritten and the 234 chars added to cost accounting. §5 |
| 4 | Fingerprint must be **verified**, not trusted | metadata and body can diverge | Recompute digest over the canonical payload excluding metadata. §6 |

Plus every round-3 correction: rollback wording and reconciliation (§4), init-time
capability warning removed (§3), read-source vs write-target path handling split
(§7), self-contradictory backup test fixed (§10), "drift becomes impossible"
narrowed (§2).

### Live bug found during round 3 — now fixed and shipped

**Full filter mode breaks `require_reply`.** `classifyMessage` returned
`marker: "untagged"` unconditionally when `mode === "full"`
(`message-filter.ts:45`), discarding the parsed marker. But the satisfaction check
is `if (replyRequired && result.marker === "reply")` (`daemon.ts:157`). So with
`AGENTBRIDGE_FILTER_MODE=full`, a Codex message correctly tagged `[REPLY]` never
set `replyReceivedDuringTurn`, and the unsatisfied-reply path at `daemon.ts:198`
fired anyway. Marker **identity** and marker **routing** were conflated in one
return value — which is exactly what §2 separates.

Fixed on `fix/full-mode-marker-identity` (`e98c6c2`), see "Shipped separately".
Round-5 Q1 answered in the affirmative by doing it: the fix landed **alone**, so
the `MARKER_SPEC` refactor now has a green regression test to build against.

The fix needed two parts, not one. Restoring marker identity alone would have
changed full-mode *routing*, because the attention-window `[STATUS]` suppression
at `daemon.ts:162` `return`s **before** the action switch — so a `[STATUS]` would
have started being buffered in full mode, breaking its forward-everything
contract. Second part: guard that branch with `FILTER_MODE !== "full"`. This is
concrete evidence for §2's premise — routing and identity were entangled in two
places, not one, and the second only became visible after fixing the first.

### Shipped separately

The `collaboration-content.ts` self-contradiction is **fixed** on branch
`fix/codex-role-contradiction` (`b825907`), open as
[PR #1](https://github.com/ngna3007/agent-bridge/pull/1) — not part of this
proposal.
`:225-227` "Default role: Implementer, Executor, Verifier" contradicted `:115-116`
"You do NOT ship the change". Default role now reads Advisor, Reviewer, Verifier;
`pin-contract.test.ts` updated plus a negative regression assertion.
WSL2, bun 1.3.10, 2026-07-27: typecheck clean, focused 52/0, full 410 pass / 2
fail / 412 (the 2 are the known WSL2 loopback timeouts).

The full-mode `require_reply` bug is **fixed** on branch
`fix/full-mode-marker-identity` (`e98c6c2`), open as
[PR #2](https://github.com/ngna3007/agent-bridge/pull/2) — also not part of this
proposal. `classifyMessage` now reports the parsed marker in full mode (action
stays `forward` for everything, routing unchanged); `daemon.ts:162` gains a
`FILTER_MODE !== "full"` guard. Tests: the two assertions that encoded the old
behavior updated, marker-identity regressions added, plus predicates mirroring
`daemon.ts`'s two decision rules (`daemon.ts` binds ports at import and cannot be
unit-imported — same precedent as `pin-contract.test.ts`).
WSL2, bun 1.3.10, 2026-07-27: typecheck clean, focused 33/0, full 418 pass / 2
fail / 420, `verify:plugin-sync` clean after `build:plugin` (bundled `daemon.js`
committed).

### Rounds 1–2 recap (already folded in)

Renamed to per-agent-**type** (`AGENTS.md` is per-repo, so two Codex instances
cannot differ); capability truth moved out of user-authored text; roster dropped
from v1; `marker-section.ts:10-11` shown Markdown-only (HTML comments are a TOML
syntax error); token baseline measured; migration made non-destructive; role
resolution split from delivery; multi-file apply demoted from "atomic".

---

## Part A — Design

### 1. Identity, and the split between resolution and delivery

`AGENTS.md` is a property of the repo, not the session, so per-instance roles are
impossible under file-based delivery. The feature is **per-agent-type roles**.
`abg init` enforces one role per target and hard-errors if two agents resolve to
the same target with different roles, naming both agents and the path.

Resolution is delivery-agnostic; the file is one delivery mechanism:

```
RoleAssignment  →  resolved responsibility text  →  delivery
 (§7 grammar)       (preset line or prose body)     ├─ file (v1, default)
                                                    └─ session override (future)
```

None of the resolution work is thrown away by a future session override, **provided
the rendered envelope declares that a session-scoped role may specialize it** (Q7)
— otherwise the file and the override contradict each other.

**Why the injected turn is not v1** — verified. `injectMessage`
(`codex-adapter.ts:225-246`) sends `params: {threadId, input:[{type:"text",text}]}`:

| Problem | Consequence |
|---|---|
| Ordinary **user** input, not system prompt | Lower authority than `AGENTS.md`; a later user message overrides it |
| Guarded by `turnInProgress` (`:234`) | Races the human's first turn after `thread/start`; injection simply refused if it loses |
| `turn/start` **starts a turn** | Model responds. Cost is input **plus a full turn of output** — not the ≈150 input tokens v2 claimed |
| Response is a normal `agentMessage` | Re-enters the forward path and reaches Claude as if it were work product |
| Visible in the transcript | Mutates the human's conversation with bookkeeping they did not write |
| `turn/start` is app-server-specific | Codex-only; not a general per-instance mechanism |

If ever built, it needs its own delivery semantics — likely an injection kind that
does not start a turn — not a reuse of `injectMessage`.

### 2. Marker spec: three layers, six projections

Round-3 blocker 1. A single unconditional marker→action table is wrong because
routing depends on `AGENTBRIDGE_FILTER_MODE` (`daemon.ts:52-53`):

| | filtered | full |
|---|---|---|
| `[REPLY]` | forward | forward |
| `[STATUS]` | buffer | forward |
| `[FYI]` | drop | forward |
| untagged | queue | forward |

`message-filter.ts:45` short-circuits full mode before the switch. And "forward"
is itself not a single behavior: whether it becomes a push notification or a pull-
queue read depends on transport mode (`AGENTBRIDGE_MODE`).

**The spec is therefore three layers, not one table:**

1. **Marker identity** — token, aliases (`IMPORTANT` → `reply`), parse rule. Mode-independent.
2. **Routing policy** — marker × filter mode → action.
3. **Delivery behavior** — action × transport mode → push / pull.

Layer 1 is what full mode currently destroys (see the live bug above): identity
must survive parsing regardless of routing.

**Six surfaces, and why they cannot assert the same thing.** Round-3 blocker 2:
`REPLY_REQUIRED_INSTRUCTION` names only `[REPLY]` and forbids `[STATUS]`/`[FYI]`
for that one case. It is not a degraded copy of the table — it is a different
*projection* of it. A test asserting "every surface's mapping equals the spec"
would fail on a correct surface.

Round 4 sharpened this further: a projection alone does not identify a surface.
`AGENTS_MD_SECTION` and `BRIDGE_CONTRACT_REMINDER` render the *same* marker-
contract projection, but they are not interchangeable — one is resident and
carries default responsibility prose, the other is a legacy per-message fallback
carrying protocol only. Each surface is therefore modelled as
**projection + lifecycle + budget**:

| Surface | Location | Chars | Projection | Lifecycle | Budget |
|---|---|---|---|---|---|
| `MARKER_REGEX` + `classifyMessage` | `message-filter.ts:31,46-60` | — | **executable** — layers 1+2 | runtime | n/a |
| `AGENTS_MD_SECTION` | `collaboration-content.ts` | 11,207 | full contract, Codex view **+ role prose** | resident (session start) | protocol cap |
| `BRIDGE_CONTRACT_REMINDER` | `message-filter.ts:63` | 4,896 | full contract, Codex view — **protocol only, no role or capability prose** | legacy fallback, per-message when pinned | legacy exemption (§5) |
| `CLAUDE_MD_SECTION` | `collaboration-content.ts` | 7,304 | Claude view — inbound delivery semantics | resident | protocol cap |
| `CLAUDE_INSTRUCTIONS` | `claude-adapter.ts:30`, served `:149` | 7,285 | Claude view — **MCP `instructions`** | resident | protocol cap |
| `REPLY_REQUIRED_INSTRUCTION` | `message-filter.ts:114` | 234 | required-reply directive — `reply` token only | per-message, event-gated | event-directive budget (§5) |

Lifecycle is what makes the budget rules in §5 assignable: a resident surface is
paid once per session, a per-message surface is paid per message, and they cannot
share a cap.

Measured on `b825907`. Codex's independent figures reproduce exactly at `b92a924`;
`AGENTS_MD_SECTION` is 232 chars larger here because the role-contradiction fix
(shipped separately) rewrote the default-role block — 10,975 → 11,207.
`CLAUDE_INSTRUCTIONS` is the surface v1–v2 missed entirely: served as the MCP
server's `instructions`, it is resident in every Claude session **in addition to**
`CLAUDE.md`. Claude-side known total **14,589 chars ≈ 3,647 tokens** before any
project context.

**Mechanism.** Each surface declares which projection it renders. The canonical
mapping **fragment** for that projection is generated from the spec and embedded
verbatim. Localization is permitted *around* the fragment — examples, tool names,
directionality, tone — never inside it.

**Testing it.** No NLP, no parsing prose. Mutate the spec; assert every renderer's
declared projection changes accordingly. A surface whose output is unaffected by a
mutation that should reach it is not deriving from the spec.

**Narrowed claim** (round 3): this makes **runtime and rendered contract drift**
mechanically guarded. It does not stop docs, manual test plans, or this proposal
from drifting — those have no generator.

### 3. Three kinds of capability

Codex sandbox policy varies by launch configuration, so git-write and network
access are **deployment** properties, not agent-type properties.

| Layer | Examples | Source | User-mutable? |
|---|---|---|---|
| **Static adapter metadata** | target format, transport, supported operations | adapter definition | no — genuinely intrinsic |
| **Runtime / deployment capability** | sandbox on/off, git write, network | detected at launch, else `unknown` | not directly |
| **User responsibility** | reviewer / executor / verifier | preset or custom prose | **yes — the feature** |

Round-3 correction: **"warn at init" is unsupported.** `abg init` runs before any
agent launches and cannot know which sandbox flags Codex will be started with.

Round-4 correction, accepted: **the runtime-capability section is removed from the
init-time envelope entirely.** v4 kept it rendering `unknown`, which is the worst
of both — it spends resident tokens to say nothing true. And the information is
redundant: an agent's real constraints already reach it through its own harness
and system instructions. An agent does not need AgentBridge to tell it that its
sandbox blocks `.git`; it finds out when it tries.

The capability model survives, scoped to where it has real information:

- **Launch diagnostics** — detected at spawn, where the flags are known.
- **Human-facing role-conflict warnings** — e.g. an `executor` assignment on an
  agent launched read-only. Shown to the operator in the terminal.
- **Never injected into the model conversation.** No capability turns, no
  capability prose in any rendered envelope.

The static adapter metadata layer stays in the envelope where relevant (target
format is needed to render at all). Only the *deployment* layer leaves.

### 4. Transactional with rollback — not atomic

POSIX has no group-rename transaction, so "write all temps, then rename; on failure
rename none" is unachievable once the first rename lands. Coordinator instead:

1. **Validate and render all** targets — any failure aborts before touching disk.
2. **Stage** temp files *and* snapshots of every original.
3. **Commit sequentially**.
4. **On process-level failure, restore** already-renamed targets from snapshots.

**No journal in v1.** The precise guarantee is **process-failure rollback,
per-file crash consistency** — each file is individually valid at all times; only
the *set* can end up mixed if the process is hard-killed mid-commit.

v4 leaned on "the next `abg init` reconciles" — which assumes the user re-runs
init. If they never do, mixed-version instruction files persist silently, which is
the failure this design exists to prevent. Round-4 fix: **launch validates** (§6).
Reconciliation still only happens in `abg init` / `abg roles apply`; launch is
detection, never repair.

Adapters render; the coordinator owns all writes:

```
interface InstructionTarget {
  discover(projectRoot): TargetPath[]     // 0..n
  format: "markdown" | "toml" | "text"    // decides marker syntax
  render(envelope): string
}
```

Format matters: `marker-section.ts:10-11` emits `<!-- id:start -->`, inert in
Markdown and plain-text rule files, a **syntax error in TOML**. One existing
behavior to preserve: `upsertMarkedSection` **throws** on a malformed marker pair
(`:45-50`) rather than appending a second block.

### 5. Cost accounting

**The v3 invariant "nothing per-message" was false.** `daemon.ts:382-383`:

```ts
if (requireReply) {
  contentToSend += REPLY_REQUIRED_INSTRUCTION;   // 234 chars, every such message
```

Replacement invariant — round-4 wording, with the legacy exemption made explicit
because without it the invariant is *still* false under `PIN_CONTRACT=always`:

> **Default mode appends no role text and no full contract per message.** Bounded,
> event-specific directives may be appended, within a hard budget, and are
> measured. **Legacy opt-in pin modes (`AGENTBRIDGE_PIN_CONTRACT=once|always`) are
> explicit exceptions** — measured, and warned about by the CLI when enabled.

`REPLY_REQUIRED_INSTRUCTION` qualifies as a bounded directive: 234 chars ≈ 59
tokens, only when Claude sets `require_reply`. It belongs in the cost table.
`BRIDGE_CONTRACT_REMINDER` (4,896 chars) is not a directive — it is the full
contract, and `always` mode appends it to **every** message. That is the
exemption, not a loophole in the invariant.

**"Bounded" is enforced, not asserted** (round 4):

```
EVENT_DIRECTIVE_MAX_CHARS             = 320   // any single directive
EVENT_DIRECTIVES_PER_MESSAGE_MAX_CHARS = 512  // sum on one message
```

Every event directive is **registered** in one table, measured against these caps,
and golden-tested. `REPLY_REQUIRED_INSTRUCTION` is the only current entry (234 —
fits). Raising either constant is an explicit, reviewed change, not a side effect
of adding text. This is what stops the next directive from arriving unmeasured.

**Savings claim withheld.** Canonicalization buys maintenance correctness, not
resident tokens: six surfaces collapsed into six *shorter* surfaces saves tokens;
six collapsed into six same-length surfaces saves none. Current content is 11,207
/ 7,304 / 7,285 / 4,896 / 234 chars.

> Build the golden renderer first. Measure rendered output. Only then state a
> saving — against the full Claude-side total (14,589 chars) including MCP
> `instructions`, not against `CLAUDE.md` alone.

The 3,600-char protocol cap is a **plausible product constraint, not a
measurement**.

Enforcement mechanics: caps expressed and enforced in **characters** (exact,
deterministic, tokenizer-independent); tokens reported as estimates from one
`estimateTokens(s) = ceil(s.length/4)` helper, always rendered `≈` — Claude and
Codex do not share a tokenizer, so one honest estimator beats a false authority.
Role text cap **600 chars (≈150 tok)**, warn at 400.

### 6. Migration and fingerprint verification

Never overwrite a block whose content we did not ship.

**Round-3 blocker 4: an embedded fingerprint proves nothing on its own** — a user
can edit the body and leave the metadata untouched. So:

1. Read the embedded metadata (schema version + fingerprint).
2. **Recompute** the digest over the canonical generated payload, **excluding the
   metadata itself**.
3. Compare. Mismatch → the modified/unrecognized path. The fingerprint is
   *verified*, never trusted.

- v2+ blocks carry version + fingerprint metadata; the hash allowlist becomes
  **legacy-only** for pre-v2 blocks.
- Verified match → migrate silently.
- Mismatch or unknown → describe as **"modified or unrecognized"**, never "user
  edited": a block can differ because it shipped from an unreleased build.
  Timestamped backup, diff summary, confirmation.
- **Non-interactive without `--yes` → write the backup, then refuse** with an
  actionable error naming the file and the flag. Never proceed silently, never
  hang on a prompt nobody can answer.
- Malformed markers → keep the current throw.

**Launch-time validation** (round 4). Before spawning an agent, `abg claude` /
`abg codex` verify each target's fingerprint against what the current
configuration would render:

| State | Behavior |
|---|---|
| Match | Continue silently. No output, no write. |
| Stale, mixed, or unrecognized | **Warn on every launch**, naming each affected file and printing the exact repair command (`abg roles apply`). Then continue — a stale instruction file is a degradation, not a reason to block the user's session. |

Two hard rules: **launch never mutates instruction files**, and the warning does
not decay into a once-per-day nudge. A silent stale state is precisely the failure
mode; repeating the warning is the point. Reconciliation happens only in
`abg init` / `abg roles apply`.

### 7. Structured assignment

**File:** `.agentbridge/roles.md` — one file, Markdown, separate from
`config.json` (which stays machine state — ports, pids).

```markdown
---
schemaVersion: 1
---

## claude
preset: executor

## codex
Senior reviewer for this repo. Read diffs against the migration plan in
docs/. Push back hard on schema changes. Do not propose refactors that
touch more than one module.
```

**Grammar.** YAML frontmatter carries `schemaVersion` and nothing else. Each
`## <agentName>` heading opens one agent's block. A block whose entire body is a
single `preset: <name>` line selects a §8 preset; any other body is custom prose,
verbatim. Nothing else is recognized — no capability fields, no delivery hints,
so a role file cannot contradict the §3 registry.

**Why Markdown and not `roles.json` + `customFile` pointers** (round-5 decision;
v5.1 supersedes v5's JSON design):

| | `roles.json` + pointers | `roles.md` |
|---|---|---|
| Files to write a custom role | 2 (`roles.json` + `roles/codex.md`) | 1 |
| What the user is authoring | prose | prose |
| Path traversal surface | `customFile` resolves an arbitrary user string | none — no read indirection exists |
| Broken-pointer failure mode | must be caught and hard-failed (a whole error class) | unrepresentable |
| Parse errors | JSON position | heading line number |

The pointer indirection bought nothing the user asked for and cost an entire
class of path-handling rules. Removing it deletes the read-source half of the
round-3 path correction outright. **The write-target half stands unchanged** —
instruction targets still may not exist yet, containment is still checked on the
**resolved parent directory**, symlinks are still inspected before writing, and
the write still goes through the §4 coordinator.

**Precedence:**

1. Block body is exactly `preset: <name>` → canonical library entry.
2. Block body is any other non-empty prose → custom role text, used verbatim.
3. Agent has no `##` block, or `roles.md` is absent → documented default preset,
   info-level note.

A block that is present but **empty** is a hard error, not a default. An empty
block is an unfinished edit; defaulting would let the user believe their role
text is live when there is none — the same failure the old broken-pointer rule
existed to prevent, carried over to the surface that replaced it.

### 8. Presets — neutralized

v3's presets asserted capabilities (`executor` "owns git", `verifier` assumes a
sandbox) and `silent` was not a role at all.

| Preset | Responsibility text (capability-neutral) |
|---|---|
| `executor` | Drives implementation. Work flows through this agent. |
| `reviewer` | Reviews plans and diffs, challenges assumptions. Does not ship. |
| `verifier` | Reproduces reported behavior and confirms or refutes it. |
| `researcher` | Reads sources and reports findings. |
| `pair` | Symmetric peer; split work by file ownership. |

`silent` **removed** — push-vs-pull is communication policy, already owned by
`AGENTBRIDGE_MODE`. A role that silently changes delivery violates the user's
"role text only" scope.

Capability statements render **only** from the §3 registry. Validation against
effective runtime capability happens **at launch**, not init (§3).

### 9. Error handling

| Case | Behavior |
|---|---|
| `roles.md` missing | All agents use documented defaults. Info note. |
| `roles.md` frontmatter malformed | Hard error with the line number. No partial apply. |
| Unsupported `schemaVersion` | Hard error naming the supported range. Never guess-parse. |
| Unknown preset name | Hard error listing valid presets. |
| Agent has no `##` block | Documented default preset. Info note. |
| `##` block present but empty | **Hard error** (§7) — unfinished edit, never a silent default. |
| Duplicate `##` block for one agent | Hard error naming the line numbers. Never last-wins. |
| `## <name>` heading names an unknown agent | Hard error listing known agent names. |
| Role text over 600 chars | Refuse at authoring time with measured count. Never truncate silently, never fail at runtime. |
| Two agents → same target, different roles | Hard error naming both agents and the path. |
| Unknown `agentType` | Error at config load. No partial envelope. |
| Read source escapes project root | Refuse after realpath containment check. |
| Write target's resolved parent escapes root | Refuse before staging. |
| Target missing / no markers / malformed | Create / append / throw (current behavior). |
| Commit fails on file 3 of 3 | Restore files 1–2 from snapshots (§4). |
| Fingerprint stale/mixed at launch | Warn every launch with the repair command; continue; never mutate (§6). |
| Event directive exceeds 320 chars, or directives sum over 512 | Hard error at registration — caught in test, never at runtime (§5). |

### 10. Open questions

- **Q4.** Per-project only, or `~/.agentbridge/` defaults with per-project
  override? Ten repos means writing "Codex reviews" ten times; costs a precedence
  rule and a second lookup site when debugging.
- **Q7.** Does the rendered envelope declare "a session-scoped role may specialize
  this"? Required for §1's future override; costs a sentence in every envelope for
  a feature that does not exist yet.
Closed: **Q8** — **option (a)**: write Grok's role only to
`.grok/rules/agentbridge.md` and let the `CLAUDE.md` / `AGENTS.md` blocks leak
in. The question assumed a third reader would be confused by inheriting two
role blocks addressed to other agents. Tested against grok 0.2.114 in this
repo, which carries both:

- *"What is your identity and which role applies to you?"* → **"Grok 4.5 (xAI)
  … AgentBridge assigns Claude = Executor and Codex = Advisor/Reviewer. Those
  map to Claude Code / Codex sessions, not to me. As Grok I am neither."**
- *"Do you have the MCP tools `reply` and `get_messages` right now?"* → **"No"**,
  with the reason, and an explicit refusal to call them. No hallucinated
  capability, which was the failure mode actually worth fearing.

The leak is legible, not confusing, because the default role text already names
its addressee inline ("You (Claude) are the Executor") — a weak form of option
(b) we get for free. So (b)'s per-envelope token cost buys nothing measurable,
and (c) inherits that cost. Revisit only if a future role text drops the inline
addressee, or if a fourth agent reads the same files and does worse.

The second probe found something larger than Q8 itself: Grok was not reasoning
about `reply` / `get_messages` from the instruction files, it had **tried to
launch our MCP server** and failed the handshake. Grok loads Claude Code's
plugin registry, AgentBridge is in it, and with `AGENTBRIDGE_ACTIVE=1` the whole
chain completes and Grok addresses `agentbridge__get_messages` by name — but it
attaches as *the Claude frontend*, into a single slot. Recorded in
`docs/scaling-plan.md` §4.1b; it is the design fork to settle before any Grok
adapter work, and it is about identity in `daemon.ts`, not about transport.

Closed: **Q5** — roles are **init-time only**; a mid-session edit does nothing
until restart, and making it live would need per-message injection. The CLI must
say this so "my edit did nothing" is not filed as a bug.

Closed: **Q6** — verified 2026-07-30 against grok 0.2.114. `grok inspect` in an
AgentBridge project lists **Project Instructions (3)**: `~/.claude/CLAUDE.md`
(global, tagged `[claude]`), the project's `CLAUDE.md`, and the project's
`AGENTS.md`. Grok honors both vendors' files. Its documented recognized set is
`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `Claude.md`, `Agents.md`
— all loaded when present. The Grok-exclusive surface, which no other agent
reads, is `<dir>/.grok/rules/*.md` (plus `$GROK_HOME/rules/`). So a Grok target
needs **no new file format**; the marker-block machinery already reaches it. What
it needs is a placement decision, which is Q8.

---

## Part B — Test plan

### Tier 1 — automated, no human, no API cost

Counts are meaningless without an environment stamp — the same suite differs per
host:

| Environment | Result | Cause |
|---|---|---|
| WSL2 (Linux 5.15.167.4-microsoft-standard-WSL2), bun 1.3.10, 2026-07-27, 130.34s, @ `b825907` | **410 / 2** of 412 | WSL2 drops SYN to closed loopback ports instead of `ECONNREFUSED`; `DaemonLifecycle > isHealthy returns false for non-existent port` and `DaemonClient > connect() rejects when server is not reachable` hang to their 5s timeout. Environment, not logic. |
| Codex sandbox, 2026-07-27 | **373 / 38** | Socket listeners prohibited. Not a regression. |
| Focused instruction/runtime, Codex sandbox, rounds 2–3 | **66 / 0** | — |
| Focused pin-contract + marker-section + message-filter, WSL2, @ `b825907` | **52 / 0** | — |

Follow-ups: bounded connect timeout (correct production behavior regardless), and
a tag for the ~38 socket-dependent tests so a sandboxed reviewer can run the rest
cleanly.

### Tier 2 — real daemon, fake peers, headless

Both ends are plain WebSockets. **Fake TUI** — WS to the proxy port speaking
app-server JSON-RPC (`initialize` → `initialized` → `thread/start`) until
`canReply()` is true. **Fake Claude frontend** — WS to the control port sending
`claude_connect`, `claude_to_codex`, `status`.

Covers admission/eviction (4001/4002/4003 + liveness probe), injection and busy
guard, marker classification **in both filter modes** (§2), delivery hints, buffer
overflow and replay, outage queue and 1011 fail-fast, session-restore replay,
`killed` sentinel, idle shutdown, orphan-reap scoping.

Settles two `scaling-plan.md` findings empirically: **F1** — init two temp
projects, wire twice, diff `~/.claude/settings.json`; predict the second is
silently skipped since `alreadyChained` ignores its path argument. **F2** — force
two project ids into one port slot, boot both daemons; predict the second dies on
uncaught `EADDRINUSE` with no user-visible error.

### Feature tests for this proposal

Base: golden files per rendered envelope; char-count assertion per block;
idempotency (render twice → byte-identical; apply twice → file unchanged); every
preset renders under cap.

| Test | Guards |
|---|---|
| Mutate spec → every renderer's declared projection changes | §2 — the enforceable form of "single source" |
| Routing table correct in **both** filter modes | §2 layer 2 |
| Marker identity survives full mode | §2 layer 1 — **already shipped** in [#2](https://github.com/ngna3007/agent-bridge/pull/2); the refactor must keep it green |
| Full mode never buffers `[STATUS]`, filtered mode still does | §2 layers 1+2 must stay independent — shipped in [#2](https://github.com/ngna3007/agent-bridge/pull/2) |
| Verified fingerprint: body edited, metadata intact → mismatch | §6 — recompute, don't trust |
| Legacy block, hash matches a known release | §6 auto-migrate |
| Legacy block unrecognized | §6 — assert **target unchanged and backup created** |
| Non-interactive, unrecognized, no `--yes` | §6 — assert target unchanged, backup created, actionable error, no hang |
| `roles.md` missing / malformed frontmatter / bad `schemaVersion` / unknown preset | §9 — four distinct hard errors, no partial apply |
| `##` block present but empty → hard fail | §7 — assert no fallback render |
| Duplicate `##` block for one agent | §7 — assert line numbers named, never last-wins |
| `## <name>` names an unknown agent | §7 — assert known names listed |
| Agent has no `##` block | §7 documented default |
| Prose body containing `preset:` plus more text is treated as prose, not a preset | §7 grammar — the preset form is the *whole* body or nothing |
| Write target's resolved parent escapes root | §7 — containment on the parent, not the target |
| Duplicate target files (same path discovered twice) | §4 discovery |
| Two agents sharing one target | §1 hard error names both |
| Commit fails on file 3 of 3 | §4 — assert files 1–2 **restored** |
| Mixed fingerprints from a killed commit → next init reconciles | §4 per-file crash consistency |
| `estimateTokens` determinism | §5 |
| Preset text asserts no capability | §8 advisory boundary |
| **No** capability prose in any rendered envelope | §3 — deployment layer removed |
| Every registered directive ≤ 320; per-message sum ≤ 512 | §5 enforced budget |
| `PIN_CONTRACT=once\|always` emits a CLI warning | §5 legacy exemption is warned, not silent |
| Launch with stale fingerprint warns and does **not** write | §6 detection ≠ repair |
| Launch with matching fingerprint is silent | §6 — no nag on the healthy path |

Removed since v2: the "malformed frontmatter" test — no frontmatter exists (§7).

### Tier 3 — needs a real terminal

Not reliably automatable: the Codex TUI is full-screen ratatui launched with
`stdio:["inherit","inherit","pipe"]` and needs a real PTY (`script -qc` drives it
blind; each turn spends the user's OpenAI quota); terminal restore (`stty -g` at
`src/cli/codex.ts:197,205,208`; six escape sequences `:225-230`) cannot be
verified headlessly; Claude-side channel rendering needs a live session.

Cheapest path: the Claude session reviewing this **is** the Claude half. One
`abg codex` in a real terminal closes the loop.

### Tier 2e — Grok attach (real leader, real TUI, real tokens)

Written from the 2026-07-30 experiment (grok 0.2.114, WSL2) recorded in
`scaling-plan.md` §4.1a. Two throwaway scripts already prove the mechanism; this
is what it takes to make them a harness. Not part of `bun test src` — every case
spends xAI tokens.

**Isolation.** `GROK_HOME` points at a temp dir with `auth.json` and `agent_id`
symlinked from `~/.grok`, and a `config.toml` carrying `[cli] use_leader = true`.
Never mutate the user's `~/.grok/config.toml` in a test. The path must be
**short** — the leader socket lives at `$GROK_HOME/leader.sock` under `SUN_LEN`
(~108 chars), and a scratchpad path overruns it, failing as
`path must be shorter than SUN_LEN` then `Timeout waiting for IPC socket to be
created`. The TUI needs a pty (`script -qec … /dev/null`) and a stdin that stays
open; a fifo opened read-write (`exec 3<>fifo`) works, opening it write-only
deadlocks before the TUI ever starts.

| Case | Asserts | Measured 2026-07-30 |
|---|---|---|
| Two `agent --leader stdio` clients, B prompts A's session with no `session/load` | Uninvited injection is accepted | `stopReason: "end_turn"` |
| Both clients' update streams after that prompt | Leader fans out; no owner-only routing | 35 chunks each, nonce in both |
| A prompts its own session afterwards | Ownership was never transferred | 29 further chunks, both clients |
| TUI launched with `use_leader = true` | TUI joins/spawns a leader | `grok leader list` → Reachable, `agent leader --relay-on-demand` |
| TUI launched with stock config | Default TUI is unreachable — the precondition is real | "No leader candidates found" against a TUI up 1h35m |
| Inject into the live TUI's session, then read `sessions/<cwd>/<id>/chat_history.jsonl` | The turn is in the *human's* transcript, not a side channel | `user: <user_query>…` + assistant reply |
| `$GROK_HOME/active_sessions.json` | Discovery surface holds `{session_id, pid, cwd}` | confirmed |
| `x.ai/sessions/list`, `x.ai/session/list`, `x.ai/session/interjection`, `x.ai/interject` | Stay unavailable — the harness must not regress onto them | `-32601 Method not found` on all four |
| Inject while the session is **mid-turn** (added 2026-07-31) | Queue / interleave / error — decides whether Grok needs the Codex outbox | **Queued to the turn boundary**: sent +3.6 s, running turn ends +6.9 s, injected turn ends +9.1 s, both clients see both |

The mid-turn answer removes work rather than adding it. Grok's leader serialises
turns per session, so the bounded outbox `src/codex-adapter.ts` maintains has no
Grok counterpart to build — an adapter just calls `session/prompt` and waits.
The one requirement it creates is a long client-side timeout, because that call
stays pending for however long the turn ahead of it runs.

True mid-turn steering does exist in grok-build at HEAD — `x.ai/interject`
(`xai-grok-shell/src/extensions/interject.rs`) queues into the session's pending
interjection buffer, drained at the next safe point in
`process_conversation_turn`, returning `"queued"`. It is absent from 0.2.114
(not in the binary, `-32601` on the wire). Feature-detect it later; do not
design around it.

**Screen rendering stays Tier 3.** Capturing a pty proves the TUI *ran* the
injected turn (title bar cycles Waiting→Responding) but not what it drew;
`--no-alt-screen` under `script` yielded only OSC title sequences. Whether the
human visibly sees an injected message needs one human looking at one terminal.

### Order

1. Bounded connect timeout → Tier 1 green and trustworthy.
2. Tier 2 harness — deterministic, free, and it *proves* F1/F2 instead of arguing them.
3. Tier 3 once, manually, per release.
4. Tier 2e only when a Grok target is actually being built — it costs tokens and
   guards nothing that ships today.

### 11. Implementation staging

Round-4 fresh-eyes finding, accepted: v4 bundled a role feature, a marker runtime
refactor, a migration engine, a multi-file coordinator, an adapter abstraction,
capability detection, and a test harness into one proposal. That is not one change.
Staged:

| PR | Contents | Status |
|---|---|---|
| **1** | Contradiction fix — `AGENTS_MD_SECTION` default role | **Open**, verified, [#1](https://github.com/ngna3007/agent-bridge/pull/1) |
| **2** | Full-mode `require_reply` bug — marker identity vs routing | **Open**, verified, [#2](https://github.com/ngna3007/agent-bridge/pull/2) |
| **3** | `MARKER_SPEC` (§2 three layers) | Next. Self-contained: runtime + renderers, no new user surface |
| **4** | `roles.md`, presets, custom prose, Markdown renderers, migration (§6), coordinator (§4) | The role feature proper |
| **later** | Non-Markdown target adapters; launch capability diagnostics (§3) | Deferred. Q6 and Q8 are both answered — Grok needs no new format and no new placement; its role goes to `.grok/rules/agentbridge.md` |

v4 listed the bug fix and the `MARKER_SPEC` refactor as one PR. Split, per
round-5 Q1: the fix is 4 files and reviewable in one sitting, and landing it
first means the refactor inherits a regression test that fails on the old
behavior. Bundling would have buried a live production bug inside a design change.

PR 3 before PR 4 is the load-bearing order: the renderers in PR 4 derive from the
spec PR 3 establishes, and building them against today's six ad-hoc surfaces would
mean rewriting them immediately.

This staging is what keeps **"role text only"** honest for v1 — PR 4 ships user-
authored responsibility prose and nothing else. Everything that is not role text
is either a prerequisite (PRs 1–3) or deferred.

---

## Part C — Round 5 review request

Rounds 1–4 findings all accepted; §§1–11 are the rewrite. Round 5 asks:

1. **§11 — Q1 self-answered, now verify the consequence.** The bug fix landed
   alone ([#2](https://github.com/ngna3007/agent-bridge/pull/2)) rather than
   bundled with the refactor. Two things to check rather than re-litigate: (a) is
   the two-part fix *sufficient* — anything else in full mode that reads the
   marker and changes behavior once identity is restored? (b) the tests transcribe
   `daemon.ts`'s decision rules as pure predicates, which will drift; is extracting
   them as exported functions from `message-filter.ts` a PR 3 obligation or
   over-engineering?
2. **§5 budgets.** 320 / 512 are proposed, not derived. The only existing directive
   is 234. Are these the right numbers, or should the per-message cap simply be
   "one directive" until a second one actually exists?
3. **§3 removal.** Deployment capability is now absent from the envelope entirely.
   Anything that genuinely regresses — a case where the agent needed to be *told*
   a constraint rather than discovering it?
4. **§6 launch warning.** Warn on every launch, never decay. Correct for
   correctness, but it is also the kind of warning users learn to scroll past. Is
   there a stronger signal that still does not block or mutate?
5. **§7 is new — review the grammar, not the choice.** Markdown over JSON is the
   user's call and is not up for re-litigation. What needs adversarial reading is
   the parse rule: a block whose *entire* body is `preset: <name>` selects a
   preset, anything else is prose. Concretely — does a prose role that happens to
   open with the word "preset:" parse the way §7 claims? Is "entire body" well
   defined once blank lines, trailing whitespace, and comments exist? And is the
   empty-block hard error reachable in practice, or does a whitespace-only block
   slip through as prose?
6. **Fresh eyes.** Ignoring all framing: what is still the wrong shape?

Known open, do not re-derive: Q4, Q7 (§10); `docs/manual-test-plan.md` still
unreconciled with Part B. Q6 and Q8 are both closed — Grok reads `CLAUDE.md`
*and* `AGENTS.md`, needs no new format, and measurably does **not** mistake the
inherited role blocks for its own, so its role goes to
`.grok/rules/agentbridge.md` and nothing else changes. The full-mode
`require_reply` bug is no longer open — fixed in
[#2](https://github.com/ngna3007/agent-bridge/pull/2).

What replaced Q8 as the open Grok question is not about roles at all: Grok
already loads our MCP server through Claude Code's plugin registry and attaches
as *the Claude frontend*, so the daemon's single `attachedClaude` slot — not the
transport — is what a third agent blocks on. `docs/scaling-plan.md` §4.1b.
