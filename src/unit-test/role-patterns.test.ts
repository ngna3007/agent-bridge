import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, CLAUDE_INSTRUCTIONS } from "../claude-adapter";
import { BRIDGE_CONTRACT_REMINDER } from "../message-filter";

describe("role-aware collaboration guidance", () => {
  test("claude instructions name the executor / advisor roles", () => {
    // New role split: Claude executes, Codex advises / reviews.
    expect(CLAUDE_INSTRUCTIONS).toContain("Claude (you): Executor");
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex: Advisor");
    expect(CLAUDE_INSTRUCTIONS).toContain("I agree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("I disagree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("Current consensus:");
  });

  test("claude instructions include turn coordination guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex is working");
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex finished");
    expect(CLAUDE_INSTRUCTIONS).toContain("busy error");
  });

  test("bridge contract reminder includes codex advisor-role guidance", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Your role: Advisor / Reviewer");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Claude is the Executor");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Challenge with evidence");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("My independent view is:");
  });

  test("bridge contract reminder includes cross-agent ultra-terse style", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("ULTRA-TERSE");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("caveman-ultra");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Arrows for causality");
  });

  test("bridge contract reminder includes the review framing passes", () => {
    // Pin the prose lifted from the ENG-1990 Phase 3 post-mortem -
    // two AI reviewers anchored on per-copy correctness and missed a
    // production-defining rule that lived in 4 places.
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Review framing");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Single source of truth");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Fresh-eyes pass");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Author blind-spot");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("production-defining");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("drift is the failure mode");
  });

  test("CLAUDE_INSTRUCTIONS teaches Claude to counter the author blind spot when requesting review", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Requesting review from Codex");
    expect(CLAUDE_INSTRUCTIONS).toContain("author blind spot");
    expect(CLAUDE_INSTRUCTIONS).toContain("single-source-of-truth pass");
    // The push-back follow-up that's most likely to flip the frame
    // when Codex anchored on local correctness.
    expect(CLAUDE_INSTRUCTIONS).toContain("fresh-eyes pass");
  });

  test("bridge contract reminder specifies marker must be at start", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST be the first text");
  });

  test("bridge contract reminder forbids git write operations", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Git Operations — FORBIDDEN");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST NOT execute any git write commands");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("hang indefinitely");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("delegated to Claude Code");
  });

  test("CLAUDE_INSTRUCTIONS is wired into MCP Server", () => {
    const adapter = new ClaudeAdapter() as any;
    // Verify the exported constant is actually passed to the Server constructor
    const serverInstructions = adapter.server._instructions;
    expect(serverInstructions).toBe(CLAUDE_INSTRUCTIONS);
  });
});
