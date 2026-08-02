import { describe, expect, test } from "bun:test";
import { IngressError, normalizeIngress, normalizeProse } from "../normalize-ingress";

const ctx = { id: "canonical1", now: 5_000 };
const current = { agent: "claude" as const, protocolVersion: 1 };
const legacy = { agent: "claude" as const, protocolVersion: null };

describe("normalizeIngress", () => {
  test("derives `from` from the socket, not the payload", () => {
    const m = normalizeIngress({ to: "grok", kind: "reply", content: "hi" }, current, ctx);
    expect(m.from).toBe("claude");
    expect(m.id).toBe("canonical1");
    expect(m.timestamp).toBe(5_000);
  });

  test("keeps the sender's own id as senderRef and never as id", () => {
    const m = normalizeIngress(
      { to: "grok", kind: "reply", content: "hi", senderRef: "chat_42" },
      current,
      ctx,
    );
    expect(m.senderRef).toBe("chat_42");
    expect(m.id).toBe("canonical1");
  });

  test("rejects a payload `from` that disagrees with the socket", () => {
    expect(() =>
      normalizeIngress({ from: "codex", kind: "reply", content: "x" }, current, ctx),
    ).toThrow(IngressError);
  });

  test("accepts a payload `from` that agrees", () => {
    const m = normalizeIngress({ from: "claude", kind: "reply", content: "x" }, current, ctx);
    expect(m.from).toBe("claude");
  });

  test("ignores `source` entirely on a legacy socket", () => {
    const m = normalizeIngress({ source: "codex", content: "x" }, legacy, ctx);
    expect(m.from).toBe("claude");
    expect(m.kind).toBe("untagged");
  });

  test("rejects an embedded marker that conflicts with the structured arguments", () => {
    expect(() =>
      normalizeIngress({ to: "grok", kind: "reply", content: "[REPLY @codex] x" }, current, ctx),
    ).toThrow(/two sources of truth|conflict/i);
  });

  test("allows an embedded marker that agrees, and strips it", () => {
    const m = normalizeIngress(
      { to: "grok", kind: "reply", content: "[REPLY @grok] x" },
      current,
      ctx,
    );
    expect(m.content).toBe("x");
  });

  test("rejects an unknown `to`", () => {
    expect(() =>
      normalizeIngress({ to: "grrok", kind: "reply", content: "x" }, current, ctx),
    ).toThrow(IngressError);
  });
});

describe("normalizeProse", () => {
  test("turns an addressed marker into the same envelope shape", () => {
    const m = normalizeProse("[REPLY @claude] tests pass", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m).toMatchObject({
      id: "canonical1",
      from: "codex",
      to: "claude",
      kind: "reply",
      content: "tests pass",
    });
  });

  test("unaddressed prose leaves `to` null for the resolver", () => {
    const m = normalizeProse("[REPLY] ok", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m.to).toBeNull();
  });

  test("untagged prose is kind untagged", () => {
    const m = normalizeProse("just thinking", { agent: "codex", protocolVersion: 1 }, ctx);
    expect(m.kind).toBe("untagged");
    expect(m.content).toBe("just thinking");
  });
});
