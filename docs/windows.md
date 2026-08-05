# AgentBridge on Windows

**Short version:** run AgentBridge under WSL2. Native Windows is not
supported, and `abg` refuses to start there rather than half-working.

## Setup

From PowerShell:

```powershell
wsl --install -d Ubuntu
```

Reboot if it asks. Then, inside the Ubuntu shell (`wsl`):

```bash
curl -fsSL https://bun.sh/install | bash
npm install -g @anthropic-ai/claude-code @openai/codex
npm install -g @rowanng/agentbridge

cd ~/code/your-project      # see "Where to keep your project" below
abg init
```

From there it is the normal two-terminal flow — `abg claude` in one WSL
shell, `abg codex` in another. Both must be inside WSL; a Claude Code
running on the Windows side cannot reach the daemon's loopback ports as
the same host.

## Where to keep your project

Prefer the Linux filesystem (`~/code/...`) over `/mnt/c/...`. Windows
drives are mounted through a 9p filesystem, and file watching and
repeated `stat` calls across that boundary are slow enough to notice in
a project of any size. If the project has to live on the Windows side,
AgentBridge still works — it is a performance cost, not a correctness
one.

## Why not native Windows

Two things, and neither is a flag away.

**Process identity.** AgentBridge proves that a live pid is its own
daemon by reading that process's command line — `/proc` on Linux, `ps -p
<pid> -o command=` on macOS. Neither exists on Windows. The check fails
closed, so the daemon becomes unrecognisable to its own tooling: `abg
kill` reports `Pid N is alive but is NOT an AgentBridge daemon —
refusing to kill`, and a first launch spends 30 seconds in the readiness
wait before timing out against a daemon that started perfectly well. The
user sees two messages that both point at their machine rather than at
the platform.

**Graceful shutdown.** `abg kill` sends SIGTERM and lets the daemon run
its own `shutdown()`: stop the control server, SIGTERM the `codex
app-server` child, clean up the pid and status files, write the stopped
tag. On Windows, `process.kill(pid, signal)` against another process
does not deliver a catchable signal — it terminates the target outright.
The handler never runs, so the app-server child is orphaned and a stale
`[CODEX READY]` can linger in the statusbar. This is a libuv-level
property shared by Node and Bun, not something a runtime upgrade fixes;
closing it means routing shutdown through IPC instead of signals.

Beyond those, the statusbar wiring written into `settings.json` is POSIX
shell (`[ ... ]`, `cat`, `tr`), and Claude Code's Windows default shell
has been native PowerShell since 2.1.139 — so the statusbar would
silently render nothing while AgentBridge reported it as wired.

There is also a reason to prefer WSL2 that has nothing to do with
AgentBridge: OpenAI still points to WSL2 for Codex CLI, because that is
where the Landlock/seccomp sandbox the models were trained against
lives. Native Windows sandboxing is the newer, less-proven path.
Supporting native Windows would mean bridging a fully-native Claude Code
to a Codex whose own vendor treats that configuration as secondary.

## The override

`AGENTBRIDGE_ALLOW_NATIVE_WINDOWS=1` downgrades the refusal to a
warning and lets the CLI run. It exists so someone porting the process
layer can reach the code past the guard. It does not make any of the
above work, and no bug report from that configuration is actionable
until the port lands.
