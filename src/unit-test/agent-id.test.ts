import { describe, expect, test } from "bun:test";
import { AGENT_IDS, isAgentId, parseAgentId } from "../agent-id";

describe("agent ids", () => {
  test("lists every addressable participant", () => {
    expect([...AGENT_IDS]).toEqual(["claude", "grok", "codex"]);
  });

  test("isAgentId accepts only the three ids", () => {
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("grok")).toBe(true);
    expect(isAgentId("system")).toBe(false);
    expect(isAgentId("Claude")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });

  test("parseAgentId is case-sensitive and returns null on a typo", () => {
    expect(parseAgentId("grok")).toBe("grok");
    expect(parseAgentId("grrok")).toBeNull();
    expect(parseAgentId("")).toBeNull();
  });
});
