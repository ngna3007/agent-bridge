import { describe, expect, test } from "bun:test";
import {
  BRIDGE_CONTRACT_REMINDER,
  MarkerError,
  StatusBuffer,
  classifyMessage,
  parseMarker,
} from "../message-filter";
import type { FilterMode } from "../message-filter";
import type { BridgeMessage } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeMsg(content: string, ts?: number): BridgeMessage {
  return { id: `test_${Date.now()}`, from: "codex", to: null, kind: "status", content, timestamp: ts ?? Date.now() };
}

describe("parseMarker", () => {
  test("extracts [REPLY] marker", () => {
    const r = parseMarker("[REPLY] task done");
    expect(r.marker).toBe("reply");
    expect(r.body).toBe("task done");
  });

  test("accepts legacy [IMPORTANT] spelling as a synonym for [REPLY]", () => {
    // Older AGENTS.md files in user projects still emit [IMPORTANT].
    // The bridge must keep accepting it until a fresh `abg init` runs.
    const r = parseMarker("[IMPORTANT] task done");
    expect(r.marker).toBe("reply");
    expect(r.body).toBe("task done");
  });

  test("extracts [STATUS] marker case-insensitive", () => {
    const r = parseMarker("[status] progress update");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress update");
  });

  test("extracts [FYI] marker", () => {
    const r = parseMarker("[FYI] background info");
    expect(r.marker).toBe("fyi");
    expect(r.body).toBe("background info");
  });

  test("returns untagged for no marker", () => {
    const r = parseMarker("plain message");
    expect(r.marker).toBe("untagged");
    expect(r.body).toBe("plain message");
  });

  test("handles leading whitespace before marker", () => {
    const r = parseMarker("  [STATUS] progress");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress");
  });

  test("handles leading newline before marker", () => {
    const r = parseMarker("\n[REPLY] urgent");
    expect(r.marker).toBe("reply");
    expect(r.body).toBe("urgent");
  });
});

describe("classifyMessage", () => {
  test("forwards REPLY in filtered mode", () => {
    expect(classifyMessage("[REPLY] x", "filtered")).toEqual({ action: "forward", marker: "reply" });
  });

  test("legacy IMPORTANT still forwards (synonym for REPLY)", () => {
    expect(classifyMessage("[IMPORTANT] x", "filtered")).toEqual({ action: "forward", marker: "reply" });
  });

  test("buffers STATUS in filtered mode", () => {
    expect(classifyMessage("[STATUS] x", "filtered")).toEqual({ action: "buffer", marker: "status" });
  });

  test("drops FYI in filtered mode", () => {
    expect(classifyMessage("[FYI] x", "filtered")).toEqual({ action: "drop", marker: "fyi" });
  });

  test("queues untagged in filtered mode (Claude pulls via get_messages)", () => {
    // Behavior change: untagged Codex output no longer auto-pushes to
    // Claude's context. It lands in the ClaudeAdapter pull queue and
    // is delivered only when Claude calls get_messages.
    expect(classifyMessage("hello", "filtered")).toEqual({ action: "queue", marker: "untagged" });
  });

  test("forwards everything in full mode", () => {
    for (const content of ["[REPLY] x", "[IMPORTANT] x", "[STATUS] x", "[FYI] x", "plain"]) {
      expect(classifyMessage(content, "full").action).toBe("forward");
    }
  });
});

describe("classifyMessage — full mode preserves marker identity (regression)", () => {
  // Regression: full mode used to return a hard-coded `marker: "untagged"`,
  // discarding what parseMarker had found. Full mode is a *routing* switch
  // ("forward everything"), but the marker is also read for *semantics*:
  // daemon.ts gates require_reply satisfaction on `result.marker === "reply"`.
  // Erasing the marker meant a correctly-tagged [REPLY] never satisfied
  // the pending request (see src/pending-requests.ts), so every
  // require_reply turn in full mode ended with a spurious `reply_missing`
  // warning to Claude once the request's TTL expired.

  test("reports the parsed marker, not untagged", () => {
    expect(classifyMessage("[REPLY] x", "full")).toEqual({ action: "forward", marker: "reply" });
    expect(classifyMessage("[STATUS] x", "full")).toEqual({ action: "forward", marker: "status" });
    expect(classifyMessage("[FYI] x", "full")).toEqual({ action: "forward", marker: "fyi" });
    expect(classifyMessage("plain", "full")).toEqual({ action: "forward", marker: "untagged" });
  });

  test("legacy [IMPORTANT] resolves to reply in full mode too", () => {
    expect(classifyMessage("[IMPORTANT] x", "full")).toEqual({ action: "forward", marker: "reply" });
  });

  test("marker matches parseMarker in both modes", () => {
    // The mode must never change *what a message is*, only where it goes.
    for (const content of ["[REPLY] x", "[STATUS] x", "[FYI] x", "plain"]) {
      const expected = parseMarker(content).marker;
      expect(classifyMessage(content, "full").marker).toBe(expected);
      expect(classifyMessage(content, "filtered").marker).toBe(expected);
    }
  });
});

describe("daemon reply-tracking decision rules (mirrors src/daemon.ts)", () => {
  // daemon.ts binds ports at import time, so it cannot be imported into a
  // unit test. These predicates are transcribed from the agentMessage
  // handler; they exist to pin the daemon-visible consequence of the
  // classifyMessage contract above. Same precedent as pin-contract.test.ts.

  /** src/daemon.ts: `if (result.marker === "reply") pendingRequests.satisfy(...)` */
  function replySatisfiedBy(contents: string[], mode: FilterMode): boolean {
    return contents.some((c) => classifyMessage(c, mode).marker === "reply");
  }

  /** src/daemon.ts: `if (FILTER_MODE !== "full" && inAttentionWindow && result.marker === "status")` */
  function suppressedByAttentionWindow(
    content: string,
    mode: FilterMode,
    inAttentionWindow: boolean,
  ): boolean {
    return mode !== "full" && inAttentionWindow && classifyMessage(content, mode).marker === "status";
  }

  test("a [REPLY] satisfies require_reply in full mode", () => {
    // This is the bug: it returned false before the fix, so the daemon
    // would have emitted reply_missing once the request's TTL expired,
    // even though Codex did reply.
    expect(replySatisfiedBy(["[REPLY] done, LGTM"], "full")).toBe(true);
  });

  test("a [REPLY] satisfies require_reply in filtered mode", () => {
    expect(replySatisfiedBy(["[REPLY] done, LGTM"], "filtered")).toBe(true);
  });

  test("non-reply traffic does not satisfy require_reply in either mode", () => {
    const noise = ["[STATUS] running tests", "[FYI] fyi", "thinking out loud"];
    expect(replySatisfiedBy(noise, "full")).toBe(false);
    expect(replySatisfiedBy(noise, "filtered")).toBe(false);
  });

  test("a [REPLY] among noise still satisfies require_reply in full mode", () => {
    expect(replySatisfiedBy(["[STATUS] a", "[REPLY] b", "[FYI] c"], "full")).toBe(true);
  });

  test("full mode never suppresses STATUS during the attention window", () => {
    // Guard on the fix: preserving the marker must not leak filtered-mode
    // buffering into full mode, whose contract is to forward everything.
    expect(suppressedByAttentionWindow("[STATUS] x", "full", true)).toBe(false);
  });

  test("filtered mode still suppresses STATUS during the attention window", () => {
    expect(suppressedByAttentionWindow("[STATUS] x", "filtered", true)).toBe(true);
    expect(suppressedByAttentionWindow("[STATUS] x", "filtered", false)).toBe(false);
    expect(suppressedByAttentionWindow("[REPLY] x", "filtered", true)).toBe(false);
  });
});

describe("StatusBuffer", () => {
  test("flushes when threshold reached", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    expect(flushed).toHaveLength(0);
    buf.add(makeMsg("[STATUS] b"));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("2 update(s)");
    buf.dispose();
  });

  test("flushes on timeout", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(1);
    buf.dispose();
  });

  test("manual flush clears buffer", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.flush("turn completed");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("flushed: turn completed");
    expect(buf.size).toBe(0);
    buf.dispose();
  });

  test("flush on empty buffer is no-op", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m));
    buf.flush("test");
    expect(flushed).toHaveLength(0);
    buf.dispose();
  });

  test("dispose clears timer and buffer", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    buf.dispose();
    await sleep(40);
    expect(flushed).toHaveLength(0);
  });
});

describe("StatusBuffer pause/resume", () => {
  test("pause suppresses threshold flush", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.add(makeMsg("[STATUS] c"));
    expect(flushed).toHaveLength(0);
    expect(buf.size).toBe(3);
    buf.dispose();
  });

  test("pause suppresses timeout flush", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(0);
    buf.dispose();
  });

  test("manual flush still works while paused", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.flush("reply message arrived");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("flushed: reply message arrived");
    buf.dispose();
  });

  test("resume triggers threshold flush if buffer is full", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.add(makeMsg("[STATUS] c"));
    expect(flushed).toHaveLength(0);
    buf.resume();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("3 update(s)");
    buf.dispose();
  });

  test("resume restarts timeout timer", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(0); // still paused
    buf.resume();
    await sleep(30);
    expect(flushed).toHaveLength(1); // timer restarted on resume
    buf.dispose();
  });
});

describe("BRIDGE_CONTRACT_REMINDER", () => {
  test("contains marker instructions for [REPLY], [STATUS], [FYI]", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[REPLY]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[STATUS]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[FYI]");
  });
});

describe("addressed markers", () => {
  test("extracts the @agent from inside the marker", () => {
    expect(parseMarker("[REPLY @grok] ship it")).toEqual({
      marker: "reply",
      to: "grok",
      body: "ship it",
    });
  });

  test("an unaddressed marker leaves `to` null", () => {
    expect(parseMarker("[REPLY] looks good")).toEqual({
      marker: "reply",
      to: null,
      body: "looks good",
    });
  });

  test("a bare @agent in prose does not address", () => {
    const parsed = parseMarker("see @grok in the diff");
    expect(parsed.marker).toBe("untagged");
    expect(parsed.to).toBeNull();
    expect(parsed.body).toBe("see @grok in the diff");
  });

  test("an unknown @name is a parse failure, not a broadcast", () => {
    expect(() => parseMarker("[REPLY @grrok] oops")).toThrow(MarkerError);
    expect(() => parseMarker("[REPLY @grrok] oops")).toThrow(/grrok/);
  });

  test("[IMPORTANT] still maps to reply and can carry an address", () => {
    expect(parseMarker("[IMPORTANT @claude] hi")).toEqual({
      marker: "reply",
      to: "claude",
      body: "hi",
    });
  });
});
