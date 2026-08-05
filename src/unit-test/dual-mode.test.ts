import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

// Access internals for testing
function createAdapter(envMode?: string): any {
  const origMode = process.env.AGENTBRIDGE_MODE;

  if (envMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = envMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }

  const adapter = new ClaudeAdapter() as any;

  // Restore env immediately after construction reads it
  if (origMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = origMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }

  return adapter;
}

function makeBridgeMessage(content: string, ts?: number) {
  return {
    id: `test_${Date.now()}`,
    from: "codex" as const,
    to: "claude" as const,
    kind: "reply" as const,
    content,
    timestamp: ts ?? Date.now(),
  };
}

/** A mailbox stand-in whose drain() the test controls directly. */
function fakeMailbox(messages: ReturnType<typeof makeBridgeMessage>[], batchId = "b1") {
  const acks: { batchId: string; ids: string[] }[] = [];
  return {
    acks,
    drain: async () => ({ batchId, messages }),
    ack: (batchId: string, ids: string[]) => acks.push({ batchId, ids }),
  };
}

describe("Dual-mode transport: mode resolution", () => {
  test("configuredMode defaults to 'auto' when AGENTBRIDGE_MODE is not set", () => {
    const adapter = createAdapter();
    expect(adapter.configuredMode).toBe("auto");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=push", () => {
    const adapter = createAdapter("push");
    expect(adapter.configuredMode).toBe("push");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=pull", () => {
    const adapter = createAdapter("pull");
    expect(adapter.configuredMode).toBe("pull");
  });

  test("invalid AGENTBRIDGE_MODE falls back to 'auto'", () => {
    const adapter = createAdapter("invalid");
    expect(adapter.configuredMode).toBe("auto");
  });

  test("auto mode defaults to push", () => {
    const adapter = createAdapter();
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("push");
    expect(adapter.getDeliveryMode()).toBe("push");
  });

  test("resolveMode sets 'push' when configuredMode is 'push'", () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("push");
    expect(adapter.getDeliveryMode()).toBe("push");
  });

  test("resolveMode sets 'pull' when configuredMode is 'pull'", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("pull");
    expect(adapter.getDeliveryMode()).toBe("pull");
  });
});

describe("Dual-mode transport: the daemon mailbox is the only store", () => {
  test("a message queued by the daemon is drainable via get_messages, not a local buffer", async () => {
    // What used to be "queueForPull adds message to pendingMessages" now
    // asserts the replacement invariant: the adapter has no buffer of its
    // own, so a waiting message is only visible by draining the mailbox.
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const mailbox = fakeMailbox([makeBridgeMessage("hello from codex")]);
    adapter.setMailbox(mailbox);

    const result = await adapter.handleGetMessages();
    expect(result).toContain("hello from codex");
    expect(mailbox.acks).toEqual([{ batchId: "b1", ids: [expect.any(String)] }]);
  });

  // The old suite also asserted that a pushed message was NOT queued —
  // that assertion encoded the defect this task removes (two ledgers, a
  // WebSocket send deciding which one a message landed in). There is now
  // one mailbox, owned by the daemon, so that case no longer applies.

  test("push mode message ids include a session-unique prefix", async () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };

    await adapter.pushNotification(makeBridgeMessage("first push", 1705312200000));
    await adapter.pushNotification(makeBridgeMessage("second push", 1705312205000));

    expect(notifications).toHaveLength(2);

    const firstId = notifications[0].params.meta.message_id as string;
    const secondId = notifications[1].params.meta.message_id as string;

    expect(firstId).toMatch(/^codex_msg_[a-f0-9]{12}_1$/);
    expect(secondId).toMatch(/^codex_msg_[a-f0-9]{12}_2$/);
    expect(firstId.replace(/_1$/, "")).toBe(secondId.replace(/_2$/, ""));
    expect(firstId).not.toBe("codex_msg_1");
  });

  test("the push notification carries the message's canonical id for dedup", async () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };

    const msg = makeBridgeMessage("wake up");
    await adapter.pushNotification(msg);

    expect(notifications[0].params.meta.canonical_id).toBe(msg.id);
  });

  test("a failed push does not throw and leaves no local trace of the message", async () => {
    // A push is a wake-up, not the delivery: the message never left the
    // daemon's mailbox, so a failed send has nothing to fall back into.
    const adapter = createAdapter("push");
    adapter.resolveMode();

    adapter.server = {
      notification: async () => {
        throw new Error("channel unavailable");
      },
    };

    await expect(adapter.pushNotification(makeBridgeMessage("fallback msg"))).resolves.toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).pendingMessages).toBeUndefined();
  });

  test("pushNotification in pull mode does not touch the MCP channel", async () => {
    // In pull mode Claude never receives a push; the message already lives
    // in the daemon's mailbox and is reached via get_messages.
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };

    await adapter.pushNotification(makeBridgeMessage("pull msg"));
    expect(notifications).toHaveLength(0);
  });
});

describe("Dual-mode transport: get_messages (handleGetMessages)", () => {
  test("returns 'No new messages.' when the mailbox drain is empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    adapter.setMailbox(fakeMailbox([]));

    const result = await adapter.handleGetMessages();
    expect(result).toBe("No new messages.");
  });

  test("returns formatted messages from the drain", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const ts = 1705312200000; // fixed timestamp for deterministic output
    const mailbox = fakeMailbox([
      makeBridgeMessage("first message", ts),
      makeBridgeMessage("second message", ts + 5000),
    ]);
    adapter.setMailbox(mailbox);

    const result = await adapter.handleGetMessages();

    expect(result).toContain("first message");
    expect(result).toContain("second message");
  });

  test("acks exactly the ids it was handed, once", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const msg1 = makeBridgeMessage("a");
    const msg2 = makeBridgeMessage("b");
    const mailbox = fakeMailbox([msg1, msg2], "batch-7");
    adapter.setMailbox(mailbox);

    await adapter.handleGetMessages();

    expect(mailbox.acks).toEqual([{ batchId: "batch-7", ids: [msg1.id, msg2.id] }]);
  });

  test("no mailbox registered reports a clear state rather than throwing", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleGetMessages();
    expect(result).toBe("AgentBridge is not connected to a daemon.");
  });
});

describe("Dual-mode transport: reply", () => {
  test("handleReply reports success without any pending-queue hint", async () => {
    // The old "N unread messages waiting" hint read the adapter's own
    // pull queue, which no longer exists. handleReply must not regress
    // to peeking the mailbox to fake that hint back in.
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true });

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    expect(result.content[0].text).toBe("Reply sent to Codex.");
  });

  test("handleReply returns error when text is missing", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing required parameter");
  });

  test("handleReply returns error when replySender is not set", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({ text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge not initialized");
  });

  test("handleReply surfaces a queued reply as a success with a note, not an error", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true, queued: true, note: "Codex is mid-turn." });

    const result = await adapter.handleReply({ text: "hello codex" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Reply queued for Codex");
    expect(result.content[0].text).toContain("Codex is mid-turn.");
  });
});
