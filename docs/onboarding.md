# AgentBridge — Onboarding & Dogfooding Walkthrough

A step-by-step tour of one full session, from `npm install` to `abg kill`. Every
command below is shown with the output you should actually see. Where the output
depends on your machine, the example is real output from a live run, with paths
left as-is so you can pattern-match against your own.

> **Version note.** The first-run setup prompt in [Step 2](#step-2--first-launch)
> ships in the `feat/auto-setup-first-run` branch (PR #4). On a release build
> before that lands, run `abg init` by hand instead — everything downstream is
> identical.

---

## 0. The 60-second mental model

You run **two terminals**. Claude Code in one, the Codex TUI in the other. They
are separate agents that cannot see each other. AgentBridge is the wire between
them.

```
Terminal 1                                        Terminal 2
┌──────────────┐                                  ┌──────────────┐
│ Claude Code  │                                  │  Codex TUI   │
└──────┬───────┘                                  └──────┬───────┘
       │ MCP stdio                                       │ websocket
       ▼                                                 ▼
   bridge.ts ──── control WS ────▶ daemon.ts ──── proxy ────▶ codex app-server
  (dies with Claude)              (survives restarts)
```

Three things follow from that picture, and they explain most of what you'll see:

1. **The daemon outlives your Claude session.** Close Claude, reopen it, and the
   conversation with Codex is still there. That's the point.
2. **Only one Claude may hold the bridge at a time.** A second `abg claude`
   evicts the first, which is why you'll sometimes see
   `[REPLACED BY NEWER SESSION]`.
3. **Traffic is one-way asymmetric.** Claude has explicit tools (`reply`,
   `get_messages`). Codex has none — the bridge reads Codex's normal output and
   routes it by a marker Codex puts at the front of the message.

Roles, in this release, are fixed: **Claude executes** (writes code, runs
commands, handles git), **Codex advises** (reviews, second-opinions, verifies in
its sandbox). See [Step 9](#step-9--what-you-can-customize).

---

## Step 1 — Install

```bash
# CLI
npm install -g @rowanng/agentbridge

# Plugin, from inside Claude Code
/plugin marketplace add ngna3007/agent-bridge
/plugin install agentbridge@agentbridge
/reload-plugins
```

`abg` and `agentbridge` are the same binary. The rest of this doc uses `abg`.

Sanity check:

```console
$ abg --version
agentbridge v0.6.8
```

**What you can do here:** nothing else yet. Do *not* run `abg init` — the next
step offers to do it for you.

---

## Step 2 — First launch

`cd` into a project and start Claude:

```console
$ cd ~/work/my-api
$ abg claude
```

Because `~/work/my-api` has no `.agentbridge/` marker yet, you get asked once:

```
Set up AgentBridge for this project?

  This directory is not set up as an AgentBridge project yet.

  Setting one up gives it a private daemon, its own port triple, and
  its own state — so several projects can run side by side. Without
  it, every unconfigured directory shares one bridge and the second
  one you launch takes the slot from the first.

  Setup writes:
    /home/you/work/my-api/.agentbridge/config.json
    a marked section in /home/you/work/my-api/CLAUDE.md and AGENTS.md

  Nothing outside those markers is modified.

> Yes, set it up        same as `abg init`
  No, use shared mode   won't ask again here
```

**What you can do:**

| Key | Result |
|---|---|
| `Enter` on **Yes** | Sets the project up, then continues launching Claude. The new ports take effect immediately, in this same session. |
| `Enter` on **No** | Launches in shared single-instance mode. Recorded per directory — you're never asked again here. |
| `Esc` | Cancels the launch entirely. Nothing is written. |

The prompt targets the **git root**, not your current directory. Run `abg claude`
from `src/` and it sets up the repo, not `src/` — otherwise the sibling `tests/`
would resolve to a different project.

**When the prompt does not appear at all:** the directory (or an ancestor) is
already a project · the shell isn't interactive (CI, pipes, harnesses) · the
target would be `$HOME` or `/` · `AGENTBRIDGE_AUTO_SETUP=0`. In every one of
those cases you get the shared fallback and nothing is written.

---

## Step 3 — What just got written

Answering yes prints exactly what it did:

```
Generating project config...
  Created: /home/you/work/my-api/.agentbridge/config.json
  Project id: 7f3c9a01
  Per-project ports: codex 15092 · proxy 15093 · control 15094

Writing role files...
  .agentbridge/roles/claude.md: created with default role
  .agentbridge/roles/codex.md: created with default role

Rendering collaboration sections...
  CLAUDE.md: appended collaboration section
  AGENTS.md: created with collaboration section

Installing AgentBridge plugin...
  Plugin installed successfully.
```

Four artifacts, and it's worth knowing what each is for:

**`.agentbridge/config.json`** — the marker directory doubles as the project
marker. Everything keys off its existence. Contents are the Codex ports, the
turn-coordination window, and the idle-shutdown delay.

**`.agentbridge/roles/claude.md` · `.agentbridge/roles/codex.md`** — what each
agent is told it is, in plain prose. Seeded with the defaults, then yours
forever: setup never overwrites an existing role file. This is the source the
next artifact is generated from. See [Step 9](#step-9--what-you-can-customize).

**`CLAUDE.md` / `AGENTS.md`** — a block between `<!-- AgentBridge:start -->` and
`<!-- AgentBridge:end -->` teaching each agent the protocol. Rendered *from* the
role files, and re-rendered on every `abg claude` / `abg codex` — so edit the
role file, not this block. `AGENTS.md` is how Codex learns the marker rules, and
because it lands in Codex's system prompt it survives `/compact`. **Anything
outside the markers is yours and is never touched**; re-running setup only
rewrites the block.

**The project id and ports.** The id is `sha256(absolute project path)` truncated
to 8 hex chars. Ports are `14500 + (id mod 1000) × 3`. Deterministic — the same
path always gets the same ports, on any machine, with no registry to keep in
sync.

**What you can do:** open `.agentbridge/config.json` and change anything in it.
Or don't — the defaults are fine. See [Step 9](#step-9--what-you-can-customize).

---

## Step 4 — Claude starts

Setup finishes and Claude launches. On a TTY you get one banner line on stderr:

```
[abg] project 7f3c9a01 · ports 15092/15093/15094 · /home/you/work/my-api
```

Read it as "this terminal is bound to *that* project". If it ever shows a path
you didn't expect, you're in the wrong directory — stop and `cd` before doing
anything else.

The daemon starts automatically in the background. You don't launch it and you
don't manage it.

**What you can do:** use Claude normally. The bridge is idle until Codex
connects.

---

## Step 5 — Start Codex (second terminal)

```console
$ cd ~/work/my-api
$ abg codex
```

Same banner, then the Codex TUI opens. Within a second Claude's side shows:

```
← agentbridge · Codex: [FYI] connected. Awaiting task.
```

Both ends are live.

> **The `--last` trap.** `abg codex resume --last` does *not* mean "resume this
> project's last conversation" — Codex's `--last` picks the newest session on the
> whole machine, then reopens it in *that* session's recorded directory. In a
> multi-project setup it will silently drop you into the wrong repo, with the TUI
> footer showing a path you never typed. Use plain `abg codex` for a fresh
> session, or `abg codex resume` for the picker (which *is* directory-filtered).
> See [Troubleshooting](#codex-tui-shows-the-wrong-directory).

---

## Step 6 — Your first exchange

Ask Claude to loop Codex in:

> "Ask Codex to review the auth middleware change."

Claude calls its `reply` tool. Codex receives it as a turn, thinks, and answers.
What happens to that answer depends on the marker Codex puts at the front:

| Codex writes | Bridge does | You see |
|---|---|---|
| `[REPLY] …` | forwards immediately | `← agentbridge · Codex: …` in Claude's conversation, interrupting whatever it's doing |
| `[STATUS] …` | buffers and summarizes | nothing now; a summary later |
| `[FYI] …` | drops | nothing |
| *(no marker)* | queues | nothing until Claude calls `get_messages` |

This is the whole point of the design. Codex is verbose by nature; without
filtering, every intermediate thought would interrupt Claude. `[REPLY]` is
reserved for "would a human teammate Slack me about this right now?" — a
proposal, a disagreement, a completion report, a blocker, an answer to a direct
question.

**What you can do:**

- Ask Claude "any update from Codex?" — that makes it drain the queue via
  `get_messages`.
- Ask for everything, unfiltered, with `AGENTBRIDGE_FILTER_MODE=full` (see
  [Step 9](#step-9--what-you-can-customize)).
- Nothing. Silence is normal and usually correct. Codex turns take minutes and
  polling doesn't speed them up.

**You don't have to time your replies.** Sending one while Codex is mid-turn is
fine: the daemon holds it in a small outbox and injects it the moment the turn
ends. Claude sees `Reply queued for Codex` and is told not to resend. The outbox
holds three messages for ten minutes by default
(`AGENTBRIDGE_REPLY_QUEUE_MAX` / `AGENTBRIDGE_REPLY_QUEUE_TTL_MS`); if anything
is dropped or expires, AgentBridge tells Claude and echoes the text back, so a
lost reply is never silent. `abg status` shows how many are held.

---

## Step 7 — Reading the status line

The bridge writes a colored tag to `<state-dir>/status.line`, and `abg claude`
wires it into Claude Code's status bar on every launch (idempotently, preserving
any status-line command you already had). It's the cheapest way to know what's
happening without asking.

| Tag | Meaning | Your move |
|---|---|---|
| `[BRIDGE READY]` | bridge up, Codex not connected yet | start `abg codex` |
| `[WAITING FOR CODEX]` | daemon up, waiting on the TUI | start `abg codex` |
| `[CODEX READY]` | idle, ready for a message | send away |
| `[CODEX THINKING]` | mid-turn | wait — don't reply now |
| `[CODEX NO REPLY]` | turn ended with no `[REPLY]` | check the TUI; Codex may have answered without the marker |
| `[CODEX UI OFFLINE]` | TUI disconnected, daemon alive | restart `abg codex`; the conversation survives |
| `[BRIDGE OFFLINE]` | bridge lost the daemon | it retries with backoff; usually self-heals |
| `[RECONNECTING]` | liveness probe running | wait a beat |
| `[REPLACED BY NEWER SESSION]` | another `abg claude` took the slot | this session is done; use the new one |
| `[ANOTHER SESSION ACTIVE]` | you're the loser of a race | close one session |
| `[CODEX FAILED]` / `[BRIDGE FAILED]` / `[RECONNECT FAILED]` | startup or reconnect failed | `abg doctor` |

Two of these deserve a note. `[CODEX UI OFFLINE]` is *not* an error — the daemon
holds the conversation, so reconnecting picks up exactly where you left off.
`[REPLACED BY NEWER SESSION]` is the single-Claude-slot rule doing its job, not
a bug.

---

## Step 8 — Day-2 commands

### `abg status` — where am I?

```console
$ abg status
AgentBridge status

Project
  id          1b3687a6
  root        /home/ngocanh/AgentBridge/agent-bridge
  codex port  16006
  proxy port  16007
  control     16008

Daemon
  state dir   /home/ngocanh/.local/state/agentbridge/1b3687a6
  status      not running
```

Read-only. Your first stop for "which project is this terminal on?".

### `abg projects` — what's running anywhere?

```console
$ abg projects
AgentBridge projects

ID         STATE              TAG                          DIRECTORY
--------------------------------------------------------------------------------
default    running (5254)     [REPLACED BY NEWER SESSION]  /home/ngocanh/.local/state/agentbridge
655868ed   stale (12134)      [WAITING FOR CODEX]          /home/ngocanh/.local/state/agentbridge/655868ed
```

Worth reading closely, because this real output shows two things you'll hit:

- **`default`** is the shared fallback slot — a daemon running for a directory
  with no `.agentbridge/` marker. If you see `default` and expected a project id,
  something was launched from an unconfigured directory.
- **`stale`** means a pid file with no live process behind it. Harmless;
  `abg kill --all` clears it.

### `abg doctor` — why is this weird?

```console
$ abg doctor
AgentBridge doctor

[ok   ] Project 1b3687a6 at /home/ngocanh/AgentBridge/agent-bridge
[WARN ] config.json codex ports drift from project-derived (expected appPort=16006, proxyPort=16007, got appPort=4500, proxyPort=4501)
        Edit /home/ngocanh/AgentBridge/agent-bridge/.agentbridge/config.json to match the derived values, or rerun `abg init` after deleting .agentbridge/config.json.
[ok   ] .agentbridge/roles/claude.md missing - claude runs on the built-in default role
        Run `abg init` here to write the default role file you can then edit.
[ok   ] .agentbridge/roles/codex.md missing - codex runs on the built-in default role
        Run `abg init` here to write the default role file you can then edit.
[ok   ] State dir: /home/ngocanh/.local/state/agentbridge/1b3687a6
[ok   ] No daemon.pid file (daemon not running)

0 error(s), 1 warning(s).
```

Again real output, and again genuine findings: this project's `config.json`
predates multi-project support, so its hard-coded `4500/4501` no longer matches
the derived `16006/16007`, and it predates role files too — so both agents fall
back to the built-in defaults. Every warning comes with the command that fixes
it.

Once role files exist, this section reports whether the rendered block still
matches them:

```
[ok   ] CLAUDE.md role section matches .agentbridge/roles/claude.md
[WARN ] AGENTS.md role section is out of date with .agentbridge/roles/codex.md (would be updated)
        Restart the agent (`abg codex`) - it re-renders the section on launch. A running codex session is still on the old text.
```

### `abg kill` — stop

```bash
abg kill        # this project's daemon + managed TUI
abg kill --all  # every project on the machine
```

`kill` writes a "killed" sentinel so the daemon doesn't immediately respawn. The
next `abg claude` clears it. That's why "kill then relaunch" works and doesn't
fight you.

---

## Step 9 — What you can customize

Printed at the end of setup, and repeated here.

### `.agentbridge/roles/claude.md` · `.agentbridge/roles/codex.md` — what each agent *is*

The important one. Role, workflow, review discipline, message style — all of it
is plain prose in these two files, and all of it is yours.

Setup seeds them with the built-in defaults (Claude executes, Codex reviews) and
**never overwrites them again**. There is no format: the file body *is* the role
text. No frontmatter, no headings the tool cares about, no presets — so there is
no such thing as a malformed role file.

The loop is three steps:

```bash
abg roles edit codex   # 1. opens the file in $EDITOR and re-renders on save
# quit the running Codex TUI
abg codex              # 2. restart — the new role takes effect
```

`abg roles edit` is only a shortcut. The files are plain markdown, so
`$EDITOR .agentbridge/roles/codex.md` then `abg codex` is exactly equivalent.

The launcher tells you when it actually changed something:

```
[agentbridge] AGENTS.md: role section updated from .agentbridge/roles/codex.md
```

and says nothing at all when the rendered block already matched — silence means
"already in sync", not "didn't run".

`abg roles` on its own answers "what is each agent actually running on":

```console
$ abg roles
Agent roles for /home/you/work/my-api

claude
  file:     .agentbridge/roles/claude.md
  source:   built-in default, unmodified
  rendered: live in CLAUDE.md

codex
  file:     .agentbridge/roles/codex.md
  source:   yours (customized)
  rendered: OUT OF DATE in AGENTS.md — restart with `abg codex`
```

| Subcommand | Use it when |
|---|---|
| `abg roles` | you want to know what's stock, what's yours, and what's stale |
| `abg roles edit <agent>` | you want to change a role and not think about paths |
| `abg roles apply` | you edited by hand and want the render now, without a restart |
| `abg roles reset <agent>` | your rewrite went badly and you want the default back |
| `abg roles path <agent>` | you're scripting it |

Things worth knowing:

- **Only the launching agent re-renders.** `abg claude` touches `CLAUDE.md`
  only; `abg codex` touches `AGENTS.md` only. A role file you're mid-edit for
  one agent can't block the other's launch.
- **An edit doesn't reach a running agent.** Instructions are read at startup.
  Restart the agent. `abg doctor` flags this exact situation:
  `AGENTS.md role section is out of date with .agentbridge/roles/codex.md`.
- **Delete a file to get the default back.** A missing role file falls back to
  the built-in text, silently.
- **An empty file is an error, not a default.** Blank means an unfinished edit.
  The launch aborts with exit 1 rather than starting an agent that silently
  ignores the role you were in the middle of writing.
- **Roles are text, not routing.** `role:` is a label the agent reads. Nothing
  in the bridge parses it — message routing is `[REPLY]` / `[STATUS]` / `[FYI]`
  and nothing else. Telling Codex it is the executor makes it *act* like one; it
  does not change which pipe a message goes down.
- **Which is why dropping the markers is warned about, not blocked.** If your
  rewrite stops explaining `[REPLY]` etc., the agent stops tagging and every
  message lands in the pull queue instead of reaching Claude. `abg roles` and
  `abg doctor` say so. You're still allowed to do it.

### `.agentbridge/config.json`

| Key | Default | Effect |
|---|---|---|
| `codex.appPort` / `codex.proxyPort` | project-derived | the ports this project uses |
| `turnCoordination.attentionWindowSeconds` | 15 | after a `[REPLY]`, how long `[STATUS]` noise stays suppressed so Claude can respond |
| `idleShutdownSeconds` | 30 | how long the daemon lingers with no client attached before exiting |

### `CLAUDE.md` / `AGENTS.md`

Everything between `<!-- AgentBridge:start -->` and `<!-- AgentBridge:end -->` is
**rendered output**, regenerated from the role files above on every launch. Edit
it and your change is gone the next time you start that agent — edit the role
file instead. Everything outside the markers is yours, permanently. Put your own
project instructions above or below the block and they'll survive every re-init.

### Environment variables

These override both the config file, the role files, and the project namespace.

| Variable | Try it when |
|---|---|
| `AGENTBRIDGE_FILTER_MODE=full` | you want to see *everything* Codex says, markers ignored |
| `AGENTBRIDGE_MODE=pull` | you don't want push interruptions; Claude fetches on demand |
| `AGENTBRIDGE_ATTENTION_WINDOW_MS` | `[STATUS]` suppression feels too long or too short |
| `AGENTBRIDGE_IDLE_SHUTDOWN_MS` | the daemon exits sooner than you'd like between sessions |
| `AGENTBRIDGE_AUTO_SETUP=0` | you never want the first-run prompt |
| `AGENTBRIDGE_STATE_DIR` | you want state somewhere specific (used verbatim, **not** nested under the project id) |

Full table: README → Configuration.

`abg doctor` checks the config, the ports, the state dir, and the role files for
drift against what the project derives.

---

## Step 10 — Multiple projects

Repeat steps 2–5 in a second project. Both run at once:

```
~/work/my-api    → id 7f3c9a01 → ports 15092/15093/15094 → state .../7f3c9a01/
~/work/my-web    → id c204b78e → ports 16344/16345/16346 → state .../c204b78e/
```

Separate daemons, separate Codex sessions, separate conversation state. Nothing
is shared and nothing collides.

The one failure mode: launch from a directory with **no** marker and you land in
the shared `default` slot along with every other unmarked directory. The second
one you launch takes the slot from the first. That's exactly what the first-run
prompt exists to prevent — which is why declining it is remembered, but skipping
it silently is not something the tool lets happen anymore.

---

## Troubleshooting

### "This directory is not set up as an AgentBridge project yet" — but I ran init

The marker search walks **up** from your current directory, never down. A marker
in a subdirectory is invisible from the parent:

```
~/AgentBridge/                ← no marker; you get the prompt here
└── agent-bridge/
    └── .agentbridge/         ← marker; invisible from the parent
```

`cd` into the directory that actually holds `.agentbridge/`, or accept the offer
to create one where you are.

### Codex TUI shows the wrong directory

Symptom: the TUI footer reads `gpt-5.6-sol medium · ~/AgentBridge` when you
launched from `~/suipay`.

Cause: `resume --last`. Codex records the working directory in each session's
`session_meta`, and `--last` picks the newest session **on the machine**, then
restores that session's directory. The picker (`abg codex resume`, no `--last`)
*is* directory-filtered; `--last` skips the picker and therefore skips the
filter.

Fixes, cheapest first:

```bash
abg codex                      # fresh session, uses the current directory
abg codex resume               # picker, already filtered to this directory
abg codex resume <id> -C "$PWD"  # explicit session, working root pinned
```

To keep `--last` ergonomics with correct scoping, resolve the id yourself:

```bash
# newest session recorded for a given directory
sid=$(codex-last-session "$PWD") && abg codex resume "$sid" -C "$PWD"
```

### `abg projects` shows `default` and I expected a project id

Something was launched from a directory with no marker. Find it, `cd` there, and
run `abg init` (or let the prompt do it). Then `abg kill --all` to clear the
stray daemon.

### doctor warns about port drift

Your `config.json` was written before the project's ports were derived — most
often a config predating multi-project support. Delete `.agentbridge/config.json`
and re-run `abg init`.

### Plain `claude` doesn't connect to the bridge

By design. The plugin self-exits unless `AGENTBRIDGE_ACTIVE=1`, which only
`abg claude` sets. It stops stray editor and background sessions from silently
claiming the single Claude slot. If you really want a non-`abg` session
attached, export `AGENTBRIDGE_ACTIVE=1` yourself.

### I edited a role file and the agent didn't change

Instructions are read once, at startup. Restart that agent — `abg claude` /
`abg codex` re-render the section on launch. `abg roles` and `abg doctor` both
confirm it: `OUT OF DATE` / `role section is out of date` before the restart,
`live` / `matches` after.

If the restart also didn't take, check that you edited
`.agentbridge/roles/<agent>.md` and not the marked block in `CLAUDE.md` /
`AGENTS.md` — the block is generated output and gets overwritten every launch.

### `abg codex` exits immediately with "Role file is empty"

You saved an empty `.agentbridge/roles/codex.md`. That's read as an unfinished
edit, not a request for the default, so the launch aborts instead of quietly
starting Codex on stock instructions. Write the role text, delete the file to
fall back to the built-in default, or `abg roles reset codex`.

### Codex stopped replying after I rewrote its role

Check `abg roles` for `no mention of [REPLY]`. Codex only pushes a message to
Claude when it tags it, and it only tags when its instructions tell it to. A
rewrite that dropped the marker rules leaves everything in the pull queue —
Claude sees it on the next `get_messages`, not as a notification. Re-add the
marker rules, or `abg roles reset codex` and edit from the default again.

### Claude stopped receiving anything

Check the status line first. `[CODEX UI OFFLINE]` → restart `abg codex`, the
conversation is intact. `[REPLACED BY NEWER SESSION]` → another `abg claude` took
the slot; use that one. Anything else → `abg doctor`.

---

## Reset to zero

```bash
abg kill --all                                  # stop every daemon
rm -rf .agentbridge/                            # un-project this dir (incl. your roles)
rm -rf ~/.local/state/agentbridge/              # Linux; drop all state incl. logs
```

Note the middle line takes `.agentbridge/roles/` with it. Copy those out first if
you've customized them.

Then delete the `<!-- AgentBridge:start -->`…`<!-- AgentBridge:end -->` block from
`CLAUDE.md` / `AGENTS.md` if you want those clean too. Next `abg claude` starts
you back at [Step 2](#step-2--first-launch).

---

## What to report when dogfooding

The useful bug report for this project is: **which step, what you expected, what
the status line said.** Attach:

```bash
abg status
abg projects
abg doctor
tail -50 ~/.local/state/agentbridge/<projectId>/agentbridge.log
```

Those four cover the project resolution, the daemon inventory, the drift checks,
and the actual failure.
