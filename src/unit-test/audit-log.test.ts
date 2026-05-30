import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog, defaultAuditLogPath } from "../audit-log";
import type { BridgeMessage } from "../types";

function fakeMsg(source: "claude" | "codex", id: string, content: string): BridgeMessage {
  return { id, source, content, timestamp: Date.now() };
}

async function waitForFile(path: string, minBytes = 1, timeoutMs = 500): Promise<void> {
  // Audit writes are queued + async via void drain(). Spin briefly until
  // the file has data (or timeout for the failure path).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && statSync(path).size >= minBytes) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("AuditLog: basics", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
    path = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("appendMessage writes one JSONL record per call", async () => {
    const log = new AuditLog(path);
    log.appendMessage(fakeMsg("claude", "m1", "hello from claude"));
    log.appendMessage(fakeMsg("codex", "m2", "hello from codex"));
    await waitForFile(path, 1);

    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);

    const r1 = JSON.parse(lines[0]!);
    expect(r1.k).toBe("msg");
    expect(r1.from).toBe("claude");
    expect(r1.to).toBe("codex");
    expect(r1.id).toBe("m1");
    expect(r1.content).toBe("hello from claude");
    expect(typeof r1.t).toBe("number");

    const r2 = JSON.parse(lines[1]!);
    expect(r2.from).toBe("codex");
    expect(r2.to).toBe("claude");
  });

  test("appendEvent records lifecycle events with meta", async () => {
    const log = new AuditLog(path);
    log.appendEvent("tui_connected", { conn_id: 7 });
    log.appendEvent("codex_ready", { thread_id: "abc123" });
    log.appendEvent("daemon_idle");
    await waitForFile(path, 1);

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs[0].k).toBe("evt");
    expect(recs[0].event).toBe("tui_connected");
    expect(recs[0].meta).toEqual({ conn_id: 7 });
    expect(recs[2].meta).toBeUndefined();
  });

  test("queryRecent filters by kind, sinceMs, limit", async () => {
    const log = new AuditLog(path);
    const startMs = Date.now();
    log.appendMessage(fakeMsg("claude", "m1", "early"));
    log.appendEvent("event_one");
    await new Promise((r) => setTimeout(r, 20));
    const midMs = Date.now();
    log.appendMessage(fakeMsg("codex", "m2", "later"));
    log.appendEvent("event_two");
    await waitForFile(path, 1);
    // Give the queue a tick to fully drain after the last append
    await new Promise((r) => setTimeout(r, 30));

    const all = log.queryRecent();
    expect(all.length).toBe(4);

    const msgsOnly = log.queryRecent({ kind: "msg" });
    expect(msgsOnly.length).toBe(2);
    expect(msgsOnly.every((r) => r.k === "msg")).toBe(true);

    const eventsOnly = log.queryRecent({ kind: "evt" });
    expect(eventsOnly.length).toBe(2);

    const sinceMid = log.queryRecent({ sinceMs: midMs });
    expect(sinceMid.length).toBeGreaterThanOrEqual(2);
    expect(sinceMid.every((r) => r.t >= midMs)).toBe(true);

    const limited = log.queryRecent({ limit: 2 });
    expect(limited.length).toBe(2);
    // Most recent N — last two appended
    expect(limited[1]).toMatchObject({ k: "evt", event: "event_two" });
    expect(startMs).toBeLessThanOrEqual(all[0]!.t);
  });

  test("never throws on bad write paths — swallows errors", async () => {
    // Point at an unwritable path: a regular file used as the parent dir
    const sentinel = join(dir, "blocker");
    Bun.write(sentinel, "x");
    const bogus = new AuditLog(join(sentinel, "audit.jsonl"));
    expect(() => bogus.appendEvent("test")).not.toThrow();
  });
});

describe("AuditLog: rotation", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-rotate-test-"));
    path = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rotates when current file exceeds maxBytes", async () => {
    // Tiny budget so even one msg triggers rotation on the next call
    const log = new AuditLog(path, { maxBytes: 100, maxRotations: 3 });
    log.appendMessage(fakeMsg("claude", "m1", "x".repeat(150)));
    await waitForFile(path, 1);

    // Second append must rotate the first because current is over budget
    log.appendMessage(fakeMsg("codex", "m2", "y".repeat(50)));
    await waitForFile(path, 1);
    // Give a moment for rotation rename to settle
    await new Promise((r) => setTimeout(r, 30));

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(path)).toBe(true);

    // Original "x" content should now be in .1; current has the new msg
    const rotated = readFileSync(`${path}.1`, "utf-8");
    expect(rotated).toContain("xxxxx");

    const current = readFileSync(path, "utf-8");
    expect(current).toContain("yyyyy");
  });

  test("shifts older rotations and drops oldest beyond maxRotations", async () => {
    const log = new AuditLog(path, { maxBytes: 50, maxRotations: 2 });
    // Append + force rotation 3 times. We expect:
    //   .1 = most recent rotated; .2 = next-most-recent; older dropped.
    for (let i = 0; i < 4; i++) {
      log.appendMessage(fakeMsg("claude", `m${i}`, "z".repeat(100)));
      await waitForFile(path, 1);
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    // .3 was the oldest of 4 rotations, should have been pruned
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  test("rotateNow forces rotation regardless of size", async () => {
    const log = new AuditLog(path, { maxBytes: 1_000_000, maxRotations: 3 });
    log.appendMessage(fakeMsg("claude", "tiny", "abc"));
    await waitForFile(path, 1);

    log.rotateNow();
    log.appendMessage(fakeMsg("codex", "after", "def"));
    await waitForFile(path, 1);
    await new Promise((r) => setTimeout(r, 30));

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(`${path}.1`, "utf-8")).toContain('"id":"tiny"');
    expect(readFileSync(path, "utf-8")).toContain('"id":"after"');
  });
});

describe("defaultAuditLogPath", () => {
  test("drops next to other state-dir files", () => {
    const stateDir = "/tmp/example-state";
    expect(defaultAuditLogPath(stateDir)).toBe("/tmp/example-state/audit.jsonl");
  });
});
