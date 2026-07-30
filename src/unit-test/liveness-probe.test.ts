import { describe, test, expect } from "bun:test";
import { probeLiveness, type ProbeTarget } from "../liveness-probe";

const OPEN = 1;
const CLOSED = 3;

function makeTarget(initial: Partial<ProbeTarget> = {}): ProbeTarget & { pingCount: number } {
  return {
    readyState: OPEN,
    pongCount: 0,
    pingCount: 0,
    ping() { this.pingCount++; },
    ...initial,
  } as ProbeTarget & { pingCount: number };
}

describe("probeLiveness", () => {
  test("returns true when pong observed before timeout", async () => {
    const target = makeTarget();

    const promise = probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    setTimeout(() => { target.pongCount++; }, 30);

    expect(await promise).toBe(true);
    expect(target.pingCount).toBe(1);
  });

  test("returns false when no pong within timeout", async () => {
    const target = makeTarget();
    const result = await probeLiveness(target, { timeoutMs: 120, pollMs: 20 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(1);
  });

  test("returns false immediately when socket is not OPEN", async () => {
    const target = makeTarget({ readyState: CLOSED });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(0);
  });

  test("returns false when ping throws", async () => {
    const target = makeTarget({
      ping() { throw new Error("socket broken"); },
    });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("returns false if readyState transitions to CLOSED mid-probe", async () => {
    const target = makeTarget();
    setTimeout(() => { target.readyState = CLOSED; }, 30);
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("a pong that arrived before the probe is not proof of liveness", async () => {
    // Bun's `sendPings: true` heartbeat leaves a nonzero count behind on
    // every socket. Whatever that count is when we start, only frames past
    // it answer the question we are asking, which is about right now.
    const target = makeTarget({ pongCount: 17 });
    const result = await probeLiveness(target, { timeoutMs: 80, pollMs: 20 });
    expect(result).toBe(false);
  });

  test("an instant pong counts, even one that lands in the same millisecond", async () => {
    // The regression this counter exists for. Loopback round-trips are
    // sub-millisecond, so a timestamped probe read its own baseline back
    // from `Date.now()`, discarded the reply as not-strictly-newer, waited
    // out the full timeout and evicted a frontend that had answered. Roughly
    // every other contest on localhost.
    const target = makeTarget();
    target.ping = function () { this.pongCount++; };

    const result = await probeLiveness(target, { timeoutMs: 80, pollMs: 20 });
    expect(result).toBe(true);
  });

  test("uses injected clock and sleep for deterministic timeout", async () => {
    let fakeNow = 0;
    const sleeps: number[] = [];
    const target = makeTarget();
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { sleeps.push(ms); fakeNow += ms; },
    });
    expect(result).toBe(false);
    // With a 100ms budget and 25ms polls, expect 4 sleeps then timeout.
    expect(sleeps.length).toBe(4);
    expect(sleeps.every((s) => s === 25)).toBe(true);
  });

  test("a pong landing on the last poll still counts", async () => {
    let fakeNow = 10_000;
    const target = makeTarget();
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
        if (fakeNow >= 10_100) target.pongCount++;
      },
    });
    expect(result).toBe(true);
  });
});
