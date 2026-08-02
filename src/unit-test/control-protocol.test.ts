import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../normalize-ingress";
import type { ControlClientMessage, ControlServerMessage } from "../control-protocol";

describe("control protocol shape", () => {
  test("claude_connect carries a protocol version", () => {
    const msg: ControlClientMessage = {
      type: "claude_connect",
      agent: "grok",
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(msg.protocolVersion).toBe(1);
  });

  test("drain and ack are client messages", () => {
    const drain: ControlClientMessage = { type: "drain", requestId: "r1" };
    const ack: ControlClientMessage = { type: "ack", batchId: "b1", ids: ["m1"] };
    expect(drain.type).toBe("drain");
    expect(ack.ids).toEqual(["m1"]);
  });

  test("hello and drain_result are server messages", () => {
    const hello: ControlServerMessage = { type: "hello", protocolVersion: PROTOCOL_VERSION };
    const result: ControlServerMessage = {
      type: "drain_result",
      requestId: "r1",
      batchId: "b1",
      messages: [],
    };
    expect(hello.protocolVersion).toBe(1);
    expect(result.messages).toEqual([]);
  });
});
