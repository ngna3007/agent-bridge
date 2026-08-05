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

  // Deliberately no sweep test: there is no sweep. See the class docblock —
  // an obligation still held means a message still queued, and expiring
  // one on a timer downgrades the delivery that eventually happens.

  test("release() drops an obligation nothing will ever discharge", () => {
    const o = new ReplyObligations();
    o.require("m1", 0);
    o.release("m1");
    expect(o.has("m1")).toBe(false);
  });

});
