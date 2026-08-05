import { describe, test, expect } from "bun:test";
import { ReplyObligations } from "../reply-obligations";

describe("ReplyObligations", () => {
  test("has() reports without consuming", () => {
    const o = new ReplyObligations();
    o.require("m1", 0);
    expect(o.has("m1")).toBe(true);
    expect(o.has("m1")).toBe(true);
    expect(o.size).toBe(1);
  });

  test("discharge() reports whether a reply was owed, once", () => {
    const o = new ReplyObligations();
    o.require("m1", 0);
    expect(o.discharge("m1")).toBe(true);
    // The second caller must not be told a reply is required — that is how
    // one message ends up with two pending requests waiting on it.
    expect(o.discharge("m1")).toBe(false);
    expect(o.size).toBe(0);
  });

  test("discharge() of an unknown id is not an error", () => {
    // Most messages carry no obligation at all; every transport calls this.
    expect(new ReplyObligations().discharge("nope")).toBe(false);
  });

  test("release() drops an obligation nothing will ever discharge", () => {
    const o = new ReplyObligations();
    o.require("m1", 0);
    o.release("m1");
    expect(o.has("m1")).toBe(false);
  });

  test("sweep() drops only entries past the ttl, and names them", () => {
    const o = new ReplyObligations();
    o.require("old", 0);
    o.require("fresh", 900);
    const stale = o.sweep(1_000, 500);
    expect(stale).toEqual(["old"]);
    expect(o.has("old")).toBe(false);
    expect(o.has("fresh")).toBe(true);
  });
});
