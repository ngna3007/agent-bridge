import { describe, expect, test } from "bun:test";
import { buildCodexLaunchSummary } from "../cli/codex";

/**
 * The Codex user has no statusbar, no push notifications, and no way to
 * ask the bridge anything from inside the TUI. This banner is the only
 * place they are told what they are attached to, so its content is a
 * behavioral contract, not decoration.
 */
describe("buildCodexLaunchSummary", () => {
  const text = (live: Parameters<typeof buildCodexLaunchSummary>[0]) =>
    buildCodexLaunchSummary(live).join("\n");

  test("says Claude is attached when it is", () => {
    expect(text({ claudeAttached: true, pendingReplyCount: 0 })).toContain("Claude   attached");
  });

  test("names the command to run when Claude is missing", () => {
    // "not attached" alone leaves the user to guess. The fix is one
    // command and it belongs on the same line as the problem.
    const out = text({ claudeAttached: false, pendingReplyCount: 0 });
    expect(out).toContain("not attached");
    expect(out).toContain("abg claude");
  });

  test("admits ignorance rather than guessing when the daemon did not answer", () => {
    const out = text(null);
    expect(out).toContain("unknown");
    expect(out).toContain("abg status");
    expect(out).not.toContain("attached —");
  });

  test("mentions held replies only when some are held", () => {
    expect(text({ claudeAttached: true, pendingReplyCount: 2 })).toContain("2 message(s) from Claude");
    expect(text({ claudeAttached: true, pendingReplyCount: 0 })).not.toContain("Waiting");
  });

  test("always explains the three routing markers", () => {
    // Codex's role file explains these too, but a role file can be
    // rewritten; this line is what makes the marker protocol
    // discoverable regardless.
    const out = text({ claudeAttached: true, pendingReplyCount: 0 });
    expect(out).toContain("[REPLY]");
    expect(out).toContain("[STATUS]");
    expect(out).toContain("[FYI]");
  });

  test("always points at the two commands that answer follow-up questions", () => {
    const out = text({ claudeAttached: true, pendingReplyCount: 0 });
    expect(out).toContain("abg status");
    expect(out).toContain("abg log -f");
  });

  test("stays short enough to survive the TUI taking the screen", () => {
    expect(buildCodexLaunchSummary({ claudeAttached: true, pendingReplyCount: 3 }).length).toBeLessThanOrEqual(8);
  });
});
