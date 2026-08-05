# AgentBridge on Windows

**Short version:** run AgentBridge under WSL2. Native Windows is not
supported, and `abg` refuses to start there rather than half-working.

Not supported means not built, not impossible. Everything below has a
known fix; the cost is roughly two to three weeks and a Windows machine
to verify on, which is why it has not been paid. If you want it, open an
issue — the shape of the work is written out in the last section.

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
shell, `abg codex` in another. Run both inside WSL.

A Windows-side Claude Code *can* reach the daemon's ports — WSL2
forwards `localhost` from Windows into the VM. The reason not to mix
sides is everything else: the two halves disagree about path form
(`C:\Users\...` vs `/mnt/c/Users/...`), about where the state directory
is, about which process owns the daemon, and about what shell runs the
statusbar command. Nothing in AgentBridge translates between them.

## Where to keep your project

Prefer the Linux filesystem (`~/code/...`) over `/mnt/c/...`. Windows
drives are mounted through a 9p filesystem, and file watching and
repeated `stat` calls across that boundary are slow enough to notice in
a project of any size. If the project has to live on the Windows side,
AgentBridge still works — it is a performance cost, not a correctness
one.

## What breaks on native Windows

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
to a Codex whose own vendor treats that configuration as secondary — so
every Codex-on-Windows bug would arrive looking like an AgentBridge bug.

## What porting it would take

None of the above is unfixable. For anyone who wants to try:

| Problem | Fix |
|---|---|
| Process identity | One shared primitive over PowerShell `Get-CimInstance Win32_Process` (not `wmic` — disabled by default on 11 24H2+). The same `ps` call is currently duplicated across `process-helpers.ts`, `daemon-lifecycle.ts`, `cli/kill.ts`, and `codex-adapter.ts`, so single-sourcing it comes first or the port silently misses one. |
| Graceful shutdown | A `shutdown` message on the control WebSocket the daemon already runs, with the SIGTERM path gated behind `platform() !== "win32"`. Signals cannot be made to work here; the path has to move to IPC. |
| Statusbar | A PowerShell branch in `settings-wire.ts`. Note the ongoing cost: every later edit to the gate/chain logic has to be made twice and stay behaviorally identical. |
| `spawn("claude" / "codex")` | `shell: true`, or `cross-spawn` — npm-global installs are `.cmd` shims that `spawn` cannot resolve directly. |
| Port-holder discovery | `Get-NetTCPConnection -LocalPort <p> -State Listen` alongside the existing `ss` / `lsof` paths. |
| State directory | `%LOCALAPPDATA%` instead of the `~/.local/state` fallback. Works today, but is not where a Windows user or backup tool looks. |
| Project id | `computeProjectId` hashes the path string, so `C:\Users\Foo` and `c:\users\foo` split one project into two port slots. Needs case normalization — which is a behavior change worth its own discussion, since case-insensitive macOS volumes have the same latent issue. |
| Tests | `e2e-cli.test.ts` fakes `claude` and `codex` as `chmod +x` shebang scripts; Windows `CreateProcess` does not read shebangs. That file's whole purpose is spawning fakes, so it needs a real retrofit rather than a skip. |

Rough total: two to three weeks to "works, mostly", and more to reach
the crash-recovery and orphan-reaping solidity Linux and macOS have
today — several of those features rest on being able to prove a live pid
is or is not a specific process.

## The override

`AGENTBRIDGE_ALLOW_NATIVE_WINDOWS=1` downgrades the refusal to a
warning and lets the CLI run. It exists so someone porting the process
layer can reach the code past the guard. It does not make any of the
above work, and no bug report from that configuration is actionable
until the port lands.
