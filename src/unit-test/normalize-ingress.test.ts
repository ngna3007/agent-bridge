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

  test("promotes the marker's address when structured `to` is absent", () => {
    const m = normalizeIngress({ kind: "reply", content: "[REPLY @codex] secret" }, current, ctx);
    expect(m.to).toBe("codex");
    expect(m.content).toBe("secret");
  });

  test("still throws when structured `to` and the marker address disagree", () => {
    expect(() =>
      normalizeIngress({ to: "grok", kind: "reply", content: "[REPLY @codex] x" }, current, ctx),
    ).toThrow(IngressError);
  });

  test("returns the shared address when structured `to` and the marker agree", () => {
    const m = normalizeIngress({ to: "grok", kind: "reply", content: "[REPLY @grok] x" }, current, ctx);
    expect(m.to).toBe("grok");
  });

  test("adopts the marker's kind for a legacy payload with no `kind` field", () => {
    const m = normalizeIngress(
      { source: "claude", content: "[REPLY @codex] hi" },
      legacy,
      ctx,
    );
    expect(m.kind).toBe("reply");
    expect(m.to).toBe("codex");
    expect(m.content).toBe("hi");
  });

  test("still throws when a present `kind` disagrees with the marker", () => {
    expect(() =>
      normalizeIngress({ kind: "status", content: "[REPLY @codex] x" }, current, ctx),
    ).toThrow(IngressError);
  });

  test("rejects a wrong-typed `content`", () => {
    expect(() => normalizeIngress({ content: 12345 }, current, ctx)).toThrow(IngressError);
  });

  test("rejects a wrong-typed `inReplyTo`", () => {
    expect(() =>
      normalizeIngress({ content: "x", inReplyTo: 42 }, current, ctx),
    ).toThrow(IngressError);
  });

  test("rejects a wrong-typed `senderRef`", () => {
    expect(() =>
      normalizeIngress({ content: "x", senderRef: { bad: true } }, current, ctx),
    ).toThrow(IngressError);
  });

  test("rejects an array payload", () => {
    expect(() => normalizeIngress([], current, ctx)).toThrow(IngressError);
  });

  test("absent optional fields still succeed", () => {
    const m = normalizeIngress({ content: "x" }, current, ctx);
    expect(m.to).toBeNull();
    expect(m.inReplyTo).toBeUndefined();
    expect(m.senderRef).toBeUndefined();
    expect(m.kind).toBe("untagged");
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
