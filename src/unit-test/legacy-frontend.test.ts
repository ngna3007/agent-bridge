import { describe, expect, test } from "bun:test";
import { forEgress } from "../daemon-egress";
import type { BridgeMessage } from "../types";

const msg: BridgeMessage = {
  id: "m1",
  from: "codex",
  to: "claude",
  kind: "reply",
  content: "x",
  timestamp: 0,
};

describe("egress compatibility", () => {
  test("a legacy frontend also gets `source` so it can still parse", () => {
    expect(forEgress(msg, null).source).toBe("codex");
  });

  test("a system notice degrades to `codex` for a legacy frontend, which has no other word for it", () => {
    expect(forEgress({ ...msg, from: "system" }, null).source).toBe("codex");
  });

  test("a grok-authored message degrades to `codex` for a legacy frontend, which predates grok entirely", () => {
    expect(forEgress({ ...msg, from: "grok" }, null).source).toBe("codex");
  });

  test("a claude-authored message keeps `claude` for a legacy frontend", () => {
    expect(forEgress({ ...msg, from: "claude" }, null).source).toBe("claude");
  });

  test("a current frontend gets no `source` field at all", () => {
    expect(forEgress(msg, 1).source).toBeUndefined();
  });
});
