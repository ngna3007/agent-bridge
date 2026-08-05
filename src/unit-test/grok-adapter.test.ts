import { describe, expect, test } from "bun:test";
import {
  GrokAdapter,
  type GrokProseIngress,
  type LeaderConnection,
  type ProxyServer,
} from "../grok-adapter";
import {
  LeaderFramer,
  LeaderProtocolError,
  encodeAcpFrame,
  encodeLeaderFrame,
  readAcpFrame,
  registerFrame,
} from "../grok-leader-protocol";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, updateText } from "../grok-acp";

/** The adapter's settle window under test, and long enough to wait it out. */
const SETTLE_MS = 20;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS * 4));

const SID = "019fd240-4ae5-7440-a8ee-ae7cb8e75638";
const OTHER_SID = "019fd241-29aa-76b0-9b92-da4516da1985";

/** One end of a byte pipe the test can drive and inspect. */
class FakeConnection implements LeaderConnection {
  readonly written: Buffer[] = [];
  closed = false;
  private dataCb: ((chunk: Buffer) => void) | null = null;
  private closeCb: (() => void) | null = null;

  write(data: Buffer): void {
    this.written.push(data);
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
  }

  /** Push bytes at whoever is reading this connection. */
  deliver(data: Buffer): void {
    this.dataCb?.(data);
  }
  /** Push one ACP message, wrapped the way the leader wraps it. */
  deliverAcp(message: unknown): void {
    this.deliver(encodeAcpFrame(message));
  }
  hangUp(): void {
    this.closed = true;
    this.closeCb?.();
  }

  /** Every ACP message written to this connection, in order. */
  acpSent(): any[] {
    const framer = new LeaderFramer();
    const out: any[] = [];
    for (const chunk of this.written) {
      for (const frame of framer.push(chunk)) {
        const acp = readAcpFrame(frame);
        if (acp !== null) out.push(acp);
      }
    }
    return out;
  }
}

class FakeServer implements ProxyServer {
  closed = false;
  private cb: ((client: LeaderConnection) => void) | null = null;
  onConnection(cb: (client: LeaderConnection) => void): void {
    this.cb = cb;
  }
  close(): void {
    this.closed = true;
  }
  connect(client: LeaderConnection): void {
    this.cb?.(client);
  }
}

/**
 * An adapter with a connected TUI.
 *
 * `upstreams` collects every leader connection the adapter opened, in
 * order: the TUI's proxied leg first, then the injection leg when it is
 * first needed.
 */
function harness(options: { orphanedInjectionWindowMs?: number } = {}) {
  const server = new FakeServer();
  const upstreams: FakeConnection[] = [];
  const adapter = new GrokAdapter({
    socketPath: "/tmp/does-not-exist.sock",
    // An injected turn ends after the proxy leg goes quiet, so the tests
    // that drive one have to outlast that window. Short, not zero: zero
    // would make the settle fire between two synchronous deliveries and
    // hide the very race it exists to close.
    injectedTurnSettleMs: SETTLE_MS,
    orphanedInjectionWindowMs: options.orphanedInjectionWindowMs,
    createServer: () => server,
    createUpstream: () => {
      const conn = new FakeConnection();
      upstreams.push(conn);
      return conn;
    },
  });
  adapter.start();
  const tui = new FakeConnection();
  server.connect(tui);
  return { adapter, server, tui, upstreams, leader: upstreams[0]! };
}

/** The frames the leader sends when the TUI opens a turn. */
function tuiPrompts(tui: FakeConnection, id: number | string, sessionId = SID): void {
  tui.deliverAcp({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
  });
}

/** The echo of a prompt, the way the leader fans it back to every client. */
function userChunk(leader: FakeConnection, text: string, sessionId = SID): void {
  leader.deliverAcp({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
    },
  });
}

function chunk(leader: FakeConnection, text: string, sessionId = SID): void {
  leader.deliverAcp({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

describe("GrokAdapter proxying", () => {
  test("forwards TUI bytes to the leader and leader bytes to the TUI", () => {
    const { tui, leader } = harness();
    const fromTui = Buffer.from("raw-from-tui");
    const fromLeader = Buffer.from("raw-from-leader");

    tui.deliver(fromTui);
    leader.deliver(fromLeader);

    expect(leader.written[0]).toEqual(fromTui);
    expect(tui.written[0]).toEqual(fromLeader);
  });

  test("forwards bytes it cannot decode rather than dropping them", () => {
    const { tui, leader } = harness();
    // A length prefix far beyond the cap: the framer refuses it, but the
    // human's session must not notice.
    const garbage = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("junk")]);
    tui.deliver(garbage);
    expect(leader.written[0]).toEqual(garbage);
  });

  test("refuses a second TUI on one project's socket", () => {
    const { server, upstreams } = harness();
    const second = new FakeConnection();
    server.connect(second);

    expect(second.closed).toBe(true);
    expect(upstreams).toHaveLength(1);
  });

  test("a TUI that disconnects can be replaced by a new one", () => {
    const { server, tui, upstreams } = harness();
    tui.hangUp();

    const second = new FakeConnection();
    server.connect(second);
    expect(second.closed).toBe(false);
    expect(upstreams).toHaveLength(2);
  });
});

describe("GrokAdapter session binding", () => {
  test("binds to the session the TUI prompts into", () => {
    const { adapter, tui } = harness();
    const attached: string[] = [];
    adapter.on("sessionAttached", (id: string) => attached.push(id));

    tuiPrompts(tui, 7);

    expect(adapter.sessionId).toBe(SID);
    expect(attached).toEqual([SID]);
  });

  test("binds from a session/new result, before the human types", () => {
    const { adapter, leader } = harness();
    leader.deliverAcp({ jsonrpc: "2.0", id: 3, result: { sessionId: SID } });
    expect(adapter.sessionId).toBe(SID);
  });

  test("forgets the session when the TUI disconnects", () => {
    const { adapter, tui } = harness();
    tuiPrompts(tui, 1);
    tui.hangUp();
    expect(adapter.sessionId).toBeNull();
    expect(adapter.tuiConnected).toBe(false);
  });
});

describe("GrokAdapter turn boundaries", () => {
  test("a turn ends when the leader answers the TUI's prompt, not when output goes quiet", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 42);
    chunk(leader, "thinking");
    chunk(leader, "... done");
    // A long pause here used to split the message. It no longer can:
    // nothing is emitted until the leader says the turn is over.
    expect(seen).toHaveLength(0);
    expect(adapter.turnPending).toBe(true);

    leader.deliverAcp({ jsonrpc: "2.0", id: 42, result: { stopReason: "end_turn" } });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("thinking... done");
    expect(seen[0]?.senderRef).toBe(`${SID}#1`);
    expect(adapter.turnPending).toBe(false);
  });

  test("emits turnStarted and turnCompleted around a turn", () => {
    const { adapter, tui, leader } = harness();
    const events: string[] = [];
    adapter.on("turnStarted", () => events.push("started"));
    adapter.on("turnCompleted", () => events.push("completed"));

    tuiPrompts(tui, 1);
    chunk(leader, "working");
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(events).toEqual(["started", "completed"]);
  });

  test("an unrelated response does not end the turn", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 5);
    chunk(leader, "half");
    // The TUI also asks the leader for settings, model lists, and so on.
    leader.deliverAcp({ jsonrpc: "2.0", id: 6, result: { models: [] } });

    expect(seen).toHaveLength(0);
    expect(adapter.turnPending).toBe(true);
  });

  test("a user message closes the previous turn", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    chunk(leader, "an answer");
    leader.deliverAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: SID,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "next" } },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("an answer");
  });

  test("a mid-flight turn is flushed when the TUI disconnects", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    chunk(leader, "streamed but never answered");
    tui.hangUp();

    // Held prose whose boundary is never coming is worse than early prose.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("streamed but never answered");
  });

  test("user messages are never forwarded as agent prose", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    leader.deliverAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: SID,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "[REPLY] from claude" },
        },
      },
    });
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toHaveLength(0);
  });

  test("thoughts and tool calls are not bus messages", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    for (const sessionUpdate of ["agent_thought_chunk", "tool_call", "plan"]) {
      leader.deliverAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: SID,
          update: { sessionUpdate, content: { type: "text", text: "internal" } },
        },
      });
    }
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toHaveLength(0);
  });

  test("ignores traffic from other projects' sessions on the shared leader", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    chunk(leader, "not ours", OTHER_SID);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toHaveLength(0);
  });

  test("a turn with no prose completes without putting an empty message on the bus", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    let completed = 0;
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.on("turnCompleted", () => { completed += 1; });

    tuiPrompts(tui, 1);
    chunk(leader, "   ");
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toHaveLength(0);
    expect(completed).toBe(1);
  });
});

describe("GrokAdapter injection", () => {
  test("prompts the bound session over its own connection, not the TUI's", () => {
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);

    expect(adapter.injectMessage("[REPLY] ship it")).toBe(true);

    // A second leader connection was opened for this.
    expect(upstreams).toHaveLength(2);
    const injector = upstreams[1]!;
    const prompt = injector.acpSent().find((m) => m.method === "session/prompt");
    expect(prompt.params.sessionId).toBe(SID);
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "[REPLY] ship it" }]);
    // The human's leg carries only what the human's TUI sent — the
    // injected text never enters their id space.
    const onHumanLeg = leader.acpSent().filter((m) => m.method === "session/prompt");
    expect(onHumanLeg).toHaveLength(1);
    expect(onHumanLeg[0].params.prompt).toEqual([{ type: "text", text: "hello" }]);
  });

  test("registers and initialises before its first prompt", () => {
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    adapter.injectMessage("hi");

    const injector = upstreams[1]!;
    const framer = new LeaderFramer();
    const frames = injector.written.flatMap((c) => framer.push(c));
    expect(frames[0]?.type).toBe("register");
    expect(injector.acpSent()[0].method).toBe("initialize");
  });

  test("reuses one injection connection across messages", () => {
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    adapter.injectMessage("one");
    adapter.injectMessage("two");
    expect(upstreams).toHaveLength(2);
  });

  test("injects mid-turn rather than refusing — the leader queues at the boundary", () => {
    const { adapter, tui, leader } = harness();
    tuiPrompts(tui, 1);
    chunk(leader, "busy with something else");
    expect(adapter.turnPending).toBe(true);

    expect(adapter.injectMessage("second in line")).toBe(true);
  });

  test("refuses to inject before a session exists", () => {
    const { adapter } = harness();
    expect(adapter.injectMessage("nobody home")).toBe(false);
  });

  test("reports a refused prompt to the correlated sender", () => {
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    const rejections: any[] = [];
    adapter.on("injectionRejected", (r) => rejections.push(r));

    adapter.injectMessage("hi", { messageId: "m1", requester: "claude", text: "hi" });
    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    injector.deliverAcp({
      jsonrpc: "2.0",
      id: promptId,
      error: { code: -32603, message: "Grok Build usage balance exhausted" },
    });

    expect(rejections).toHaveLength(1);
    expect(rejections[0].messageId).toBe("m1");
    expect(rejections[0].reason).toContain("balance exhausted");
    // The leader answered, so nothing ran. That is a fact, and the
    // sender is allowed to act on it by resending.
    expect(rejections[0].delivery).toBe("rejected");
  });

  test("a successful prompt raises no rejection", () => {
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    const rejections: any[] = [];
    adapter.on("injectionRejected", (r) => rejections.push(r));

    adapter.injectMessage("hi", { messageId: "m1", requester: "claude", text: "hi" });
    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });

    expect(rejections).toHaveLength(0);
  });

  test("an injected turn's answer is flushed when the leader answers our prompt", async () => {
    // Nothing on the proxy leg can end this turn: the prompt came from
    // here, so the TUI has no `session/prompt` of its own outstanding.
    // Without this boundary the answer sits buffered until the human
    // happens to type again — which may be never.
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.injectMessage("what is 2+2", { messageId: "m1", requester: "claude", text: "q" });

    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    chunk(leader, "four");
    expect(seen).toHaveLength(0);

    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("four");
    // And it says whose turn it was, so the daemon can route the answer
    // back to the requester instead of broadcasting it.
    expect(seen[0]?.respondingTo).toEqual({ messageId: "m1", requester: "claude", text: "q" });
  });

  test("an answer that beats its own prose across the sockets is not lost", async () => {
    // The two facts about one injected turn arrive on two sockets with
    // no ordering between them: the prose fans out on the proxy leg, the
    // "turn over" response comes back on the injector leg. When the
    // response won, the turn used to end against an empty buffer — the
    // correlation was discarded, and the prose that landed a moment
    // later sat there with no boundary and no `respondingTo`, so the
    // `require_reply` it answered could never be satisfied.
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.injectMessage("what is 2+2", { messageId: "m1", requester: "claude", text: "q" });

    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    // Response first, prose second — the ordering that used to lose it.
    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    chunk(leader, "four");
    expect(seen).toHaveLength(0);

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("four");
    expect(seen[0]?.respondingTo).toEqual({ messageId: "m1", requester: "claude", text: "q" });
  });

  test("the echo of our own prompt does not eat the answer's correlation", async () => {
    // The real order, when the verdict wins its race: response on the
    // injector leg, then the leader's echo of the prompt we injected on
    // the proxy leg, then the answer. That echo ends a turn — it is how
    // the adapter learns a new one started — and it used to consume the
    // settle window on its way past, against an empty buffer. The
    // answer then streamed in belonging to nobody.
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.injectMessage("what is 2+2", { messageId: "m1", requester: "claude", text: "q" });

    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    userChunk(leader, "what is 2+2");
    chunk(leader, "four");

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("four");
    expect(seen[0]?.respondingTo).toEqual({ messageId: "m1", requester: "claude", text: "q" });
  });

  test("a turn the leader ran anyway is still attributed after the injector dies", async () => {
    // "Unknown" delivery cuts both ways. The verdict that would have
    // closed this turn is never coming — the socket it would arrive on
    // is gone — but the leader may have read the prompt before the
    // socket died and be answering right now. Dropping the correlation
    // with the connection left that answer unattributed, so the
    // `require_reply` it settles could never be satisfied.
    const { adapter, tui, upstreams, leader } = harness({ orphanedInjectionWindowMs: SETTLE_MS * 6 });
    tuiPrompts(tui, 1);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.injectMessage("what is 2+2", { messageId: "m1", requester: "claude", text: "q" });

    upstreams[1]!.hangUp();
    chunk(leader, "four");

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("four");
    expect(seen[0]?.respondingTo).toEqual({ messageId: "m1", requester: "claude", text: "q" });
  });

  test("prose still streaming holds the injected turn open", async () => {
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));
    adapter.injectMessage("count", { messageId: "m1", requester: "claude", text: "q" });

    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });

    // Each chunk restarts the settle window, so a slow stream cannot be
    // cut in half by a boundary that already arrived.
    for (const part of ["one ", "two ", "three"]) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 2));
      chunk(leader, part);
    }
    expect(seen).toHaveLength(0);

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("one two three");
  });

  test("a turn the human started is not attributed to anyone", () => {
    const { adapter, tui, leader } = harness();
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    tuiPrompts(tui, 1);
    chunk(leader, "thinking out loud");
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen[0]?.respondingTo).toBeNull();
  });

  test("a lost injection connection reports its in-flight prompts as unknown", () => {
    // The transport self-acks, so the mailbox copy is already gone by the
    // time the prompt is on the wire. A connection that dies mid-flight
    // would otherwise be indistinguishable from a delivery that worked.
    //
    // Reported as `unknown`, not rejected: the bytes were written, and
    // the leader may well have run the turn. Calling this a refusal
    // would license a resend that runs the same turn twice.
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    const rejections: any[] = [];
    adapter.on("injectionRejected", (r) => rejections.push(r));

    adapter.injectMessage("hi", { messageId: "m1", requester: "claude", text: "hi" });
    upstreams[1]!.hangUp();

    expect(rejections).toHaveLength(1);
    expect(rejections[0].messageId).toBe("m1");
    expect(rejections[0].reason).toContain("closed before the prompt was answered");
    expect(rejections[0].delivery).toBe("unknown");
  });

  test("a close after the answer arrived fails nothing", () => {
    const { adapter, tui, upstreams } = harness();
    tuiPrompts(tui, 1);
    const rejections: any[] = [];
    adapter.on("injectionRejected", (r) => rejections.push(r));

    adapter.injectMessage("hi", { messageId: "m1", requester: "claude", text: "hi" });
    const injector = upstreams[1]!;
    const promptId = injector.acpSent().find((m) => m.method === "session/prompt").id;
    injector.deliverAcp({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    injector.hangUp();

    expect(rejections).toHaveLength(0);
  });

  test("does not double-count updates that arrive on both connections", () => {
    const { adapter, tui, upstreams, leader } = harness();
    tuiPrompts(tui, 1);
    adapter.injectMessage("hi");
    const injector = upstreams[1]!;
    const seen: GrokProseIngress[] = [];
    adapter.on("agentMessage", (m: GrokProseIngress) => seen.push(m));

    // The leader fans the same update out to every client.
    chunk(leader, "answer");
    chunk(injector, "answer");
    leader.deliverAcp({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("answer");
  });
});

describe("grok-leader-protocol", () => {
  test("round-trips a control frame", () => {
    const framer = new LeaderFramer();
    const frames = framer.push(encodeLeaderFrame({ type: "register", client_type: "x" }));
    expect(frames).toEqual([{ type: "register", client_type: "x" }]);
  });

  test("reassembles a frame split across chunks", () => {
    const framer = new LeaderFramer();
    const whole = encodeAcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(framer.push(whole.subarray(0, 6))).toEqual([]);
    const frames = framer.push(whole.subarray(6));
    expect(readAcpFrame(frames[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize" });
  });

  test("splits two frames sharing one chunk", () => {
    const framer = new LeaderFramer();
    const both = Buffer.concat([
      encodeLeaderFrame({ type: "a" }),
      encodeLeaderFrame({ type: "b" }),
    ]);
    expect(framer.push(both).map((f) => f.type)).toEqual(["a", "b"]);
  });

  test("refuses an absurd length rather than allocating for it", () => {
    const framer = new LeaderFramer();
    const bogus = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("x")]);
    expect(() => framer.push(bogus)).toThrow(LeaderProtocolError);
  });

  test("skips an unparseable frame without losing the next one", () => {
    const framer = new LeaderFramer();
    const bad = Buffer.from("not json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bad.length, 0);
    const stream = Buffer.concat([header, bad, encodeLeaderFrame({ type: "b" })]);
    expect(framer.push(stream).map((f) => f.type)).toEqual(["b"]);
  });

  test("readAcpFrame ignores non-acp frames and unparseable payloads", () => {
    expect(readAcpFrame({ type: "registered", client_id: 8 })).toBeNull();
    expect(readAcpFrame({ type: "acp" })).toBeNull();
    expect(readAcpFrame({ type: "acp", payload: "{oops" })).toBeNull();
  });

  test("registerFrame declares no filesystem or terminal capability", () => {
    const framer = new LeaderFramer();
    const frame = framer.push(registerFrame("agentbridge"))[0] as any;
    expect(frame.type).toBe("register");
    expect(frame.capabilities.fs_read).toBe(false);
    expect(frame.capabilities.fs_write).toBe(false);
    expect(frame.capabilities.terminal).toBe(false);
  });
});

describe("grok-acp helpers", () => {
  test("tells requests, responses, and notifications apart", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "session/prompt" };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    const notification = { jsonrpc: "2.0", method: "session/update" };

    expect(isJsonRpcRequest(request)).toBe(true);
    expect(isJsonRpcResponse(request)).toBe(false);
    expect(isJsonRpcNotification(request)).toBe(false);

    expect(isJsonRpcResponse(response)).toBe(true);
    expect(isJsonRpcRequest(response)).toBe(false);

    expect(isJsonRpcNotification(notification)).toBe(true);
    expect(isJsonRpcRequest(notification)).toBe(false);
  });

  test("accepts string ids as well as numeric ones", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: "abc", method: "x" })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: "abc", error: { code: 1, message: "m" } })).toBe(true);
  });

  test("rejects values that are not JSON-RPC at all", () => {
    for (const junk of [null, 42, "str", [], {}]) {
      expect(isJsonRpcRequest(junk)).toBe(false);
      expect(isJsonRpcResponse(junk)).toBe(false);
      expect(isJsonRpcNotification(junk)).toBe(false);
    }
  });

  test("updateText reads text content and rejects empty", () => {
    expect(updateText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toBe("hi");
    expect(updateText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toBeNull();
    expect(updateText({ sessionUpdate: "plan" })).toBeNull();
    expect(updateText(undefined)).toBeNull();
  });
});
