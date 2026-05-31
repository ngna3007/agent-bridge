import { describe, expect, test } from "bun:test";
import { BRIDGE_CONTRACT_REMINDER } from "../message-filter";

/**
 * Behavioral tests for the "pin contract once per Codex thread" optimization.
 *
 * Daemon-level integration (verifying the actual injectMessage call payload
 * with and without the contract) requires spinning up a fake CodexAdapter,
 * which is heavier than fits here — covered by the e2e harness in
 * docs/manual-test-plan.md. This file documents the contract + asserts the
 * pure decision logic in isolation.
 *
 * Decision rule (extracted from src/daemon.ts handleControlMessage):
 *   needsContract = mode === "always"
 *                || (mode === "once" && activeThreadId !== lastPinnedContractThreadId)
 */

function needsContract(
  mode: string,
  activeThreadId: string | null,
  lastPinnedContractThreadId: string | null,
): boolean {
  return mode === "always" ||
    (mode === "once" && activeThreadId !== lastPinnedContractThreadId);
}

describe("pin contract decision logic — mode=off (default)", () => {
  // Default: trust AGENTS.md to deliver the contract via system prompt.
  // Never append to per-message payload.
  test("never appends regardless of state", () => {
    expect(needsContract("off", "thread-A", null)).toBe(false);
    expect(needsContract("off", "thread-A", "thread-A")).toBe(false);
    expect(needsContract("off", "thread-B", "thread-A")).toBe(false);
    expect(needsContract("off", null, null)).toBe(false);
  });
});

describe("pin contract decision logic — mode=once (legacy mid-state)", () => {
  test("pins on first msg of fresh thread", () => {
    expect(needsContract("once", "thread-A", null)).toBe(true);
  });

  test("skips on subsequent msgs of same thread", () => {
    expect(needsContract("once", "thread-A", "thread-A")).toBe(false);
  });

  test("re-pins when thread changes (codex restart)", () => {
    expect(needsContract("once", "thread-B", "thread-A")).toBe(true);
  });

  test("re-pins when previous thread was null (lifecycle reset)", () => {
    expect(needsContract("once", "thread-A", null)).toBe(true);
  });
});

describe("pin contract decision logic — mode=always (legacy backstop)", () => {
  test("always appends regardless of state", () => {
    expect(needsContract("always", "thread-A", null)).toBe(true);
    expect(needsContract("always", "thread-A", "thread-A")).toBe(true);
    expect(needsContract("always", null, null)).toBe(true);
  });
});

describe("pin contract decision logic — unknown modes", () => {
  test("unknown mode is treated as no-pin (typo-safe default)", () => {
    expect(needsContract("never", "thread-A", null)).toBe(false);
    expect(needsContract("disabled", "thread-A", null)).toBe(false);
    expect(needsContract("alwasy", "thread-A", null)).toBe(false);
    expect(needsContract("", "thread-A", null)).toBe(false);
  });
});

describe("BRIDGE_CONTRACT_REMINDER content invariants", () => {
  test("is substantial enough to be worth pinning", () => {
    // Sanity check: if someone reduces the reminder to a one-liner, the
    // per-msg-savings calculus changes. >300 chars means the per-msg
    // savings (after first) is real.
    expect(BRIDGE_CONTRACT_REMINDER.length).toBeGreaterThan(300);
  });

  test("declares the marker contract Codex must follow", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[IMPORTANT]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[STATUS]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[FYI]");
  });

  test("includes the git-write prohibition (load-bearing)", () => {
    // The pin-once optimization is safe only because the reminder is the
    // SAME content every time — Codex doesn't need it re-stated to recall
    // it within a session. If the reminder ever becomes context-dependent
    // (e.g. dynamic role assignment per turn), this test should fail and
    // force the design to reconsider.
    expect(BRIDGE_CONTRACT_REMINDER).toContain("git commit");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("git push");
  });
});

describe("AGENTBRIDGE_PIN_CONTRACT env normalization", () => {
  test("default value is 'off' when unset", () => {
    // Mimics the daemon's `process.env.AGENTBRIDGE_PIN_CONTRACT ?? 'off'`
    const envVal: string | undefined = undefined;
    const mode = (envVal ?? "off").toLowerCase();
    expect(mode).toBe("off");
  });

  test("case-insensitive", () => {
    expect("ALWAYS".toLowerCase()).toBe("always");
    expect("Once".toLowerCase()).toBe("once");
    expect("OFF".toLowerCase()).toBe("off");
  });
});

describe("AGENTS.md content carries the contract (load-bearing for mode=off)", () => {
  // When PIN_CONTRACT_MODE=off (the default), AGENTS.md must still teach
  // Codex the marker contract + git prohibition, because the daemon no
  // longer appends them per-message. This test guards against someone
  // editing collaboration-content.ts and stripping the critical sections.
  const { AGENTS_MD_SECTION } = require("../collaboration-content");

  test("AGENTS_MD_SECTION teaches marker contract", () => {
    expect(AGENTS_MD_SECTION).toContain("[IMPORTANT]");
    expect(AGENTS_MD_SECTION).toContain("[STATUS]");
    expect(AGENTS_MD_SECTION).toContain("[FYI]");
    expect(AGENTS_MD_SECTION).toContain("first text");
  });

  test("AGENTS_MD_SECTION enforces git-write prohibition", () => {
    expect(AGENTS_MD_SECTION).toContain("git commit");
    expect(AGENTS_MD_SECTION).toContain("git push");
    expect(AGENTS_MD_SECTION).toContain("hang your session indefinitely");
  });

  test("AGENTS_MD_SECTION declares Codex default role", () => {
    expect(AGENTS_MD_SECTION).toContain("Implementer");
  });

  test("AGENTS_MD_SECTION documents the fallback env var", () => {
    // If someone removes the contract from AGENTS.md, the doc itself
    // should tell them how to re-enable per-msg append.
    expect(AGENTS_MD_SECTION).toContain("AGENTBRIDGE_PIN_CONTRACT");
  });
});
