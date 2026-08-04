import { describe, expect, test } from "bun:test";
import { INDEX_TTL_MS, LEASE_TIMEOUT_MS, MAILBOX_CAPACITY } from "../daemon-constants";

describe("daemon mailbox retention", () => {
  test("the index TTL outlives the mailbox lease", () => {
    // A recipient may reply at any point inside the TTL. If the index
    // expired first, a valid reply would become a parse failure — silent
    // loss wearing a different hat.
    expect(INDEX_TTL_MS).toBeGreaterThan(LEASE_TIMEOUT_MS);
  });

  test("the mailbox capacity is bounded", () => {
    expect(MAILBOX_CAPACITY).toBeGreaterThan(0);
    expect(MAILBOX_CAPACITY).toBeLessThanOrEqual(1_000);
  });
});
