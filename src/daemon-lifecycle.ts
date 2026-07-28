import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { StateDirResolver } from "./state-dir";
import { probeControlPort, describeControlPortConflict } from "./port-preflight";

// When bundled into a Claude Code plugin, the frontend runs from the plugin
// cache directory and the daemon bundle sits next to bridge-server.js, so
// "./daemon.js" resolves correctly. When the CLI runs standalone (e.g.
// `abg codex` from `dist/cli.js`), the daemon bundle lives one level up
// under `plugins/agentbridge/server/daemon.js`; that's the next fallback.
// AGENTBRIDGE_DAEMON_ENTRY overrides both (used by e2e tests).
function resolveDaemonPath(): string {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) {
    return fileURLToPath(new URL(process.env.AGENTBRIDGE_DAEMON_ENTRY, import.meta.url));
  }
  const candidates = [
    "./daemon.js",                                  // plugin bundle layout
    "../plugins/agentbridge/server/daemon.js",      // npm-install / local-link cli layout
    "./daemon.ts",                                  // src/ layout (when running from source)
  ];
  for (const rel of candidates) {
    const abs = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(abs)) return abs;
  }
  // Fall back to the original path so the error message names the file
  // we tried to spawn rather than failing silently inside child_process.
  return fileURLToPath(new URL("./daemon.ts", import.meta.url));
}
const DAEMON_PATH = resolveDaemonPath();

export interface DaemonLifecycleOptions {
  stateDir: StateDirResolver;
  controlPort: number;
  log: (msg: string) => void;
  /**
   * Project this caller belongs to. Defaults to the resolved
   * namespace's id. `null` means single-instance mode, which accepts
   * any daemon on the port — see `identityMatches`.
   */
  projectId?: string | null;
}

/**
 * Cap on every health/readiness probe.
 *
 * A bare `fetch` to a port nothing listens on is only fast when the
 * host answers with RST. Where a firewall drops the SYN instead — WSL2
 * with the default Windows firewall does exactly this — connect() runs
 * out the kernel's SYN retries first: measured at 141s per probe on
 * that platform, which is 141s of an unexplained hang before
 * `ensureRunning` even tries to launch the daemon, and turns
 * `waitForReady`'s 40 retries into over an hour.
 *
 * A probe is a question about a local process. If it cannot be
 * answered in a second and a half, the answer is no.
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * Shared daemon lifecycle management.
 * Used by both CLI (agentbridge codex) and plugin frontend (bridge.ts).
 */
export class DaemonLifecycle {
  private readonly stateDir: StateDirResolver;
  private readonly controlPort: number;
  private readonly log: (msg: string) => void;
  private readonly projectId: string | null;
  /** So a retry loop reports a foreign daemon once, not forty times. */
  private reportedForeignDaemon = false;

  constructor(opts: DaemonLifecycleOptions) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
    this.projectId =
      opts.projectId !== undefined ? opts.projectId : (process.env.AGENTBRIDGE_PROJECT_ID ?? null);
  }

  get healthUrl(): string {
    return `http://127.0.0.1:${this.controlPort}/healthz`;
  }

  get readyUrl(): string {
    return `http://127.0.0.1:${this.controlPort}/readyz`;
  }

  get controlWsUrl(): string {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }

  /** Ensure daemon is running: check health, check pid, start if needed. */
  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      await this.waitForReady();
      return;
    }

    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        // Verify the live process is actually our daemon, not an OS-reused PID
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForReady(12, 250);
            return;
          } catch {
            throw new Error(
              `Found existing daemon process ${existingPid}, but control port ${this.controlPort} never became ready.`,
            );
          }
        }
        // Live process but NOT our daemon — stale PID reused by OS
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removeStalePidFile();
    }

    // Acquire startup lock to prevent concurrent launches
    const lockAcquired = this.acquireLock();
    if (!lockAcquired) {
      // Another process is launching the daemon — wait for it
      this.log("Another process is starting the daemon, waiting for readiness...");
      await this.waitForReady();
      return;
    }

    try {
      // The daemon refuses to bind a port it does not own, so launching
      // into a collision produces a detached process that logs and
      // exits — and the caller would only learn that as a readiness
      // timeout half a minute later. Ask first and say the real reason.
      const holder = await probeControlPort(this.controlPort);
      if (holder.kind !== "free") {
        throw new Error(describeControlPortConflict(this.controlPort, this.projectId, holder));
      }
      this.launch();
      await this.waitForReady();
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Whether the daemon *this project owns* is up on the control port.
   *
   * Two separate questions, and the second one used to be missing.
   * Project ids hash into 1000 port slots, so two projects on one
   * machine can derive the same control port; a probe that only asked
   * "does something answer /healthz?" would say yes to the other
   * project's daemon. `ensureRunning` would then skip launching, and
   * this project's Claude would sit attached to another project's
   * Codex — no error anywhere, messages crossing between two unrelated
   * repos. Identity has to be part of the health question.
   */
  async isHealthy(): Promise<boolean> {
    const probe = await this.probe(this.healthUrl);
    return probe !== null && probe.ok && this.acceptsDaemon(probe.body);
  }

  /**
   * A probe result: `null` when nothing answered (closed port, timeout,
   * non-JSON body), otherwise the HTTP status and parsed body.
   */
  private async probe(url: string): Promise<{ ok: boolean; body: unknown } | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A 503 from /readyz still carries a body; anything that is not
        // JSON is not our daemon, and `acceptsDaemon` decides what that
        // means rather than this parser.
      }
      return { ok: response.ok, body };
    } catch {
      return null;
    }
  }

  /** Does the daemon that answered belong to this project? */
  private acceptsDaemon(body: unknown): boolean {
    const reported =
      body && typeof body === "object" && "projectId" in body
        ? ((body as { projectId?: string | null }).projectId ?? null)
        : undefined;

    if (DaemonLifecycle.identityMatches(this.projectId, reported)) return true;

    if (!this.reportedForeignDaemon) {
      this.reportedForeignDaemon = true;
      this.log(
        `Control port ${this.controlPort} is held by the daemon of project ${reported} ` +
          `(this project is ${this.projectId}). Not attaching to it. ` +
          `Run \`abg doctor\` — two projects derive the same port slot.`,
      );
    }
    return false;
  }

  /**
   * Whether a daemon reporting `reported` may serve a caller belonging
   * to `expected`.
   *
   * - No expectation (single-instance mode, or an explicit port/state
   *   dir the user chose): accept anything. This is the pre-0.7
   *   behaviour and the only sane answer when there is no project to
   *   compare against.
   * - `undefined` reported: a daemon from before /healthz carried an
   *   id. Accept it, so an upgrade does not orphan a running daemon;
   *   it is replaced on its next restart.
   * - Otherwise the ids must be equal.
   */
  static identityMatches(expected: string | null, reported: string | null | undefined): boolean {
    if (expected === null) return true;
    if (reported === undefined) return true;
    return reported === expected;
  }

  /** Wait for daemon to become healthy. */
  async waitForHealthy(maxRetries = 40, delayMs = 250): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon health on ${this.healthUrl}`);
  }

  /** Check if daemon is ready to accept Codex TUI connections. */
  async isReady(): Promise<boolean> {
    const probe = await this.probe(this.readyUrl);
    return probe !== null && probe.ok && this.acceptsDaemon(probe.body);
  }

  /** Wait for daemon to become ready. */
  async waitForReady(maxRetries = 40, delayMs = 250): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isReady()) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon readiness on ${this.readyUrl}`);
  }

  /** Read daemon status from status.json. */
  readStatus(): { proxyUrl?: string; controlPort?: number; pid?: number } | null {
    try {
      const raw = readFileSync(this.stateDir.statusFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Write daemon status to status.json. */
  writeStatus(status: Record<string, unknown>): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.statusFile, JSON.stringify(status, null, 2) + "\n", "utf-8");
  }

  /** Read daemon PID from pid file. */
  readPid(): number | null {
    try {
      const raw = readFileSync(this.stateDir.pidFile, "utf-8").trim();
      if (!raw) return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** Write daemon PID to pid file. */
  writePid(pid?: number): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.pidFile, `${pid ?? process.pid}\n`, "utf-8");
  }

  /** Remove stale pid file. */
  removePidFile(): void {
    try {
      unlinkSync(this.stateDir.pidFile);
    } catch {}
  }

  /** Remove status file. */
  removeStatusFile(): void {
    try {
      unlinkSync(this.stateDir.statusFile);
    } catch {}
  }

  /** Write killed sentinel — prevents auto-reconnect from relaunching daemon. */
  markKilled(): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.killedFile, `${Date.now()}\n`, "utf-8");
  }

  /** Remove killed sentinel — allows daemon to be launched again. */
  clearKilled(): void {
    try {
      unlinkSync(this.stateDir.killedFile);
    } catch {}
  }

  /** Check if daemon was intentionally killed by the user. */
  wasKilled(): boolean {
    return existsSync(this.stateDir.killedFile);
  }

  /** Launch daemon as detached background process. */
  private launch(): void {
    this.stateDir.ensure();
    this.log(`Launching detached daemon on control port ${this.controlPort}`);

    const daemonProc = spawn(process.execPath, ["run", DAEMON_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
        AGENTBRIDGE_STATE_DIR: this.stateDir.dir,
      },
      detached: true,
      stdio: "ignore",
    });
    daemonProc.unref();
  }

  private removeStalePidFile(): void {
    this.log("Removing stale pid file");
    this.removePidFile();
  }

  /**
   * Try to acquire the startup lock file exclusively.
   * Returns true if the lock was acquired, false if another process holds it.
   */
  private acquireLock(depth = 0): boolean {
    if (depth > 1) {
      this.log("Lock acquisition failed after retry, proceeding without lock");
      return true;
    }
    this.stateDir.ensure();
    try {
      const fd = openSync(this.stateDir.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Check if the lock holder is still alive — recover from stale locks
        // left by crashed launchers
        try {
          const holderPid = Number.parseInt(readFileSync(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && !isProcessAlive(holderPid)) {
            this.log(`Stale lock file from dead process ${holderPid}, removing`);
            this.releaseLock();
            return this.acquireLock(depth + 1);
          }
        } catch {
          // Can't read lock file — remove and retry
          this.log("Cannot read lock file, removing stale lock");
          this.releaseLock();
          return this.acquireLock(depth + 1);
        }
        return false;
      }
      // Non-EEXIST error (permissions, etc.) — log and proceed without lock
      this.log(`Warning: could not acquire startup lock: ${err.message}`);
      return true;
    }
  }

  /** Release the startup lock file. */
  private releaseLock(): void {
    try {
      unlinkSync(this.stateDir.lockFile);
    } catch {}
  }

  /**
   * Kill daemon process precisely.
   * Returns true if a process was found and killed.
   */
  async kill(gracefulTimeoutMs = 3000): Promise<boolean> {
    const pid = this.readPid();
    if (!pid) {
      this.log("No daemon pid file found");
      this.cleanup();
      return false;
    }

    if (!isProcessAlive(pid)) {
      this.log(`Daemon pid ${pid} is not alive, cleaning up stale files`);
      this.cleanup();
      return false;
    }

    // Verify the PID actually belongs to an AgentBridge daemon.
    // If the PID file is stale and the OS has reused the PID,
    // we must NOT kill an unrelated process.
    if (!this.isDaemonProcess(pid)) {
      this.log(`Pid ${pid} is alive but is NOT an AgentBridge daemon — refusing to kill. Cleaning up stale pid file.`);
      this.cleanup();
      return false;
    }

    // Try graceful shutdown first (SIGTERM)
    this.log(`Sending SIGTERM to daemon pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.cleanup();
      return false;
    }

    // Wait for graceful shutdown
    const deadline = Date.now() + gracefulTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        this.log(`Daemon pid ${pid} stopped gracefully`);
        this.cleanup();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Force kill (SIGKILL)
    this.log(`Daemon pid ${pid} did not stop gracefully, sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}

    this.cleanup();
    return true;
  }

  /**
   * Verify that a live PID actually belongs to an AgentBridge daemon
   * by checking the process command line. Prevents killing an unrelated
   * process when the OS has reused a stale PID.
   */
  private isDaemonProcess(pid: number): boolean {
    // Always verify via process command line — status.json/pid files can be
    // stale and matching PIDs only proves two local files agree, not that
    // the live process is actually AgentBridge.
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      return cmd.includes("daemon") && (cmd.includes("agentbridge") || cmd.includes("agent_bridge"));
    } catch {
      // ps failed — process may have exited between our check and the ps call
      return false;
    }
  }

  /** Clean up all state files. */
  private cleanup(): void {
    this.removePidFile();
    this.removeStatusFile();
    this.releaseLock();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { isProcessAlive };
