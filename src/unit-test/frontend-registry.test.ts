import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FRONTEND_AGENT,
  FrontendRegistry,
  parseFrontendAgent,
} from "../frontend-registry";

/** A socket stand-in whose state the test controls directly. */
interface FakeSocket {
  id: string;
  state: "open" | "closing" | "closed";
}

const socket = (id: string, state: FakeSocket["state"] = "open"): FakeSocket => ({ id, state });

function registry(maxBufferedMessages = 100) {
  return new FrontendRegistry<FakeSocket, string>({
    maxBufferedMessages,
    isOpen: (s) => s.state === "open",
    isClosed: (s) => s.state === "closed",
  });
}

describe("parseFrontendAgent", () => {
  test("an absent agent means Claude, so pre-0.8 frontends keep working", () => {
    expect(parseFrontendAgent(undefined)).toBe("claude");
    expect(parseFrontendAgent(null)).toBe("claude");
    expect(DEFAULT_FRONTEND_AGENT).toBe("claude");
  });

  test("known agents pass through", () => {
    expect(parseFrontendAgent("claude")).toBe("claude");
    expect(parseFrontendAgent("grok")).toBe("grok");
  });

  test("anything else is rejected rather than coerced", () => {
    // Coercing an unknown name to Claude would put a stranger in
    // Claude's slot, which is the failure this whole module exists
    // to stop.
    expect(parseFrontendAgent("codex")).toBeNull();
    expect(parseFrontendAgent("Claude")).toBeNull();
    expect(parseFrontendAgent(7)).toBeNull();
    expect(parseFrontendAgent({})).toBeNull();
  });
});

describe("slots", () => {
  test("two different agents hold slots at the same time", () => {
    const r = registry();
    const claude = socket("claude-1");
    const grok = socket("grok-1");

    r.claim("claude", claude);
    r.claim("grok", grok);

    expect(r.size).toBe(2);
    expect(r.occupant("claude")).toBe(claude);
    expect(r.occupant("grok")).toBe(grok);
    expect(r.attachedAgents()).toEqual(["claude", "grok"]);
  });

  test("a Grok frontend does not contest Claude's slot", () => {
    // The regression this module was written for: Grok loads our MCP
    // server through Claude Code's plugin registry and used to land in
    // the single `attachedClaude` variable.
    const r = registry();
    r.claim("claude", socket("claude-1"));

    expect(r.contestedBy("grok", socket("grok-1"))).toBeNull();
  });

  test("a second frontend for the same agent does contest it", () => {
    const r = registry();
    const incumbent = socket("claude-1");
    r.claim("claude", incumbent);

    expect(r.contestedBy("claude", socket("claude-2"))).toBe(incumbent);
  });

  test("a slot held by an already-closed socket is free", () => {
    const r = registry();
    r.claim("claude", socket("claude-1", "closed"));

    expect(r.contestedBy("claude", socket("claude-2"))).toBeNull();
  });

  test("a closing-but-not-closed incumbent is still contested", () => {
    // Issue #68: the OS may never surface FIN for a crashed peer, so
    // "not yet closed" cannot be read as "gone" without a probe.
    const r = registry();
    const incumbent = socket("claude-1", "closing");
    r.claim("claude", incumbent);

    expect(r.contestedBy("claude", socket("claude-2"))).toBe(incumbent);
  });

  test("re-claiming with the same socket is not a contest", () => {
    const r = registry();
    const claude = socket("claude-1");
    r.claim("claude", claude);

    expect(r.contestedBy("claude", claude)).toBeNull();
  });

  test("isAttached reports writability, not merely occupancy", () => {
    const r = registry();
    r.claim("claude", socket("claude-1", "closing"));

    expect(r.size).toBe(1);
    expect(r.isAttached("claude")).toBe(false);
    expect(r.isAttached("grok")).toBe(false);
  });
});

describe("release", () => {
  test("a stale detach cannot evict the socket that replaced it", () => {
    const r = registry();
    const first = socket("claude-1");
    const second = socket("claude-2");
    r.claim("claude", first);
    r.claim("claude", second);

    expect(r.release("claude", first)).toBe(false);
    expect(r.occupant("claude")).toBe(second);

    expect(r.release("claude", second)).toBe(true);
    expect(r.occupant("claude")).toBeNull();
  });

  test("releaseSocket finds the agent a socket was serving", () => {
    const r = registry();
    const grok = socket("grok-1");
    r.claim("claude", socket("claude-1"));
    r.claim("grok", grok);

    expect(r.releaseSocket(grok)).toBe("grok");
    expect(r.attachedAgents()).toEqual(["claude"]);
    expect(r.releaseSocket(grok)).toBeNull();
  });
});

describe("probes", () => {
  test("a probe for one agent does not block another", () => {
    const r = registry();
    r.beginProbe("claude");

    expect(r.isProbing("claude")).toBe(true);
    expect(r.isProbing("grok")).toBe(false);

    r.endProbe("claude");
    expect(r.isProbing("claude")).toBe(false);
  });
});

describe("recipients", () => {
  test("a message is never routed back to its source", () => {
    const r = registry();
    r.claim("claude", socket("claude-1"));
    r.claim("grok", socket("grok-1"));

    expect(r.recipients("claude").map((x) => x.agent)).toEqual(["grok"]);
    expect(r.recipients("grok").map((x) => x.agent)).toEqual(["claude"]);
  });

  test("a Codex-sourced message reaches every attached frontend", () => {
    const r = registry();
    r.claim("claude", socket("claude-1"));
    r.claim("grok", socket("grok-1"));

    expect(r.recipients("codex").map((x) => x.agent)).toEqual(["claude", "grok"]);
    expect(r.recipients().map((x) => x.agent)).toEqual(["claude", "grok"]);
  });

  test("unwritable sockets are skipped so the caller buffers instead", () => {
    const r = registry();
    r.claim("claude", socket("claude-1", "closing"));
    r.claim("grok", socket("grok-1"));

    expect(r.recipients("codex").map((x) => x.agent)).toEqual(["grok"]);
  });
});

describe("buffers", () => {
  test("each agent gets its own buffer", () => {
    const r = registry();
    r.buffer("claude", "for-claude");
    r.buffer("grok", "for-grok");

    expect(r.bufferedCount("claude")).toBe(1);
    expect(r.bufferedCount("grok")).toBe(1);
    expect(r.bufferedCount()).toBe(2);
    expect(r.takeBuffered("claude")).toEqual(["for-claude"]);
    expect(r.bufferedCount("grok")).toBe(1);
  });

  test("draining leaves the buffer empty", () => {
    const r = registry();
    r.buffer("claude", "a");
    r.buffer("claude", "b");

    expect(r.takeBuffered("claude")).toEqual(["a", "b"]);
    expect(r.takeBuffered("claude")).toEqual([]);
    expect(r.bufferedCount("claude")).toBe(0);
  });

  test("overflow drops oldest first and reports how many", () => {
    const r = registry(3);
    for (const m of ["a", "b", "c"]) r.buffer("claude", m);
    expect(r.buffer("claude", "d")).toEqual({ dropped: 1 });
    expect(r.takeBuffered("claude")).toEqual(["b", "c", "d"]);
  });

  test("a failed flush puts the remainder back in front of newer messages", () => {
    const r = registry();
    r.buffer("claude", "old-1");
    r.buffer("claude", "old-2");

    const taken = r.takeBuffered("claude");
    r.buffer("claude", "arrived-during-flush");
    r.requeue("claude", taken.slice(1));

    expect(r.takeBuffered("claude")).toEqual(["old-2", "arrived-during-flush"]);
  });

  test("requeue of nothing is a no-op", () => {
    const r = registry();
    r.buffer("claude", "a");
    r.requeue("claude", []);
    expect(r.takeBuffered("claude")).toEqual(["a"]);
  });

  test("a re-buffer may exceed the cap; the next buffer settles it", () => {
    // Matches the daemon's long-standing behavior: the cap is enforced
    // on arrival, not on rescue, so a failed flush never discards the
    // messages it just failed to deliver.
    const r = registry(2);
    r.requeue("claude", ["x", "y", "z"]);
    expect(r.bufferedCount("claude")).toBe(3);

    r.buffer("claude", "w");
    expect(r.takeBuffered("claude")).toEqual(["z", "w"]);
  });
});

describe("known agents", () => {
  test("Claude is known before it ever attaches", () => {
    // The daemon has always buffered for Claude before its first
    // connect; losing that would change every existing session.
    expect(registry().knownAgents()).toEqual(["claude"]);
  });

  test("an agent becomes known by attaching or by being buffered for", () => {
    const r = registry();
    r.claim("grok", socket("grok-1"));
    expect(r.knownAgents()).toEqual(["claude", "grok"]);

    const other = registry();
    other.buffer("grok", "held");
    expect(other.knownAgents()).toEqual(["claude", "grok"]);
  });
});
