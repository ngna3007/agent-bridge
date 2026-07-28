import { afterEach, describe, expect, test } from "bun:test";
import { describeControlPortConflict, probeControlPort } from "../port-preflight";
import type { ControlPortHolder } from "../port-preflight";

/**
 * A control-port collision used to surface as `Failed to start server.
 * Is port 17843 in use?` from an uncaught exception in `Bun.serve`, and
 * the message that explains port slots never ran. These tests pin the
 * two halves of the fix: identifying the holder, and saying so.
 */

describe("describeControlPortConflict", () => {
  const named: ControlPortHolder = { kind: "agentbridge", projectId: "def67890", pid: 4242 };

  test("names the other project, this project, and the way out", () => {
    const msg = describeControlPortConflict(17843, "abc12345", named);

    expect(msg).toContain("17843");
    expect(msg).toContain("project def67890");
    expect(msg).toContain("pid 4242");
    expect(msg).toContain("Project abc12345");
    expect(msg).toContain("abg doctor");
    expect(msg).toContain("AGENTBRIDGE_CONTROL_PORT");
    expect(msg).toContain("abg kill");
  });

  test("explains why two projects can land on one port", () => {
    // Without this, a collision reads as a bug rather than as the
    // documented consequence of hashing ids into 1000 slots.
    expect(describeControlPortConflict(17843, "abc12345", named)).toContain("1000 slots");
  });

  test("omits the pid when the holder did not report one", () => {
    const msg = describeControlPortConflict(17843, "abc12345", {
      kind: "agentbridge",
      projectId: "def67890",
      pid: null,
    });
    expect(msg).not.toContain("pid");
  });

  test("calls out a pre-0.7 daemon that cannot say whose it is", () => {
    const msg = describeControlPortConflict(17843, "abc12345", {
      kind: "agentbridge",
      projectId: undefined,
      pid: null,
    });
    expect(msg).toContain("older AgentBridge daemon");
  });

  test("distinguishes a daemon running outside any project", () => {
    const msg = describeControlPortConflict(17843, "abc12345", {
      kind: "agentbridge",
      projectId: null,
      pid: null,
    });
    expect(msg).toContain("outside any project");
  });

  test("does not claim a project id the caller does not have", () => {
    const msg = describeControlPortConflict(4502, null, named);
    expect(msg).toContain("This project");
    expect(msg).not.toContain("Project null");
  });

  test("a non-AgentBridge squatter gets a different instruction", () => {
    const msg = describeControlPortConflict(17843, "abc12345", { kind: "unknown" });

    expect(msg).toContain("not an AgentBridge daemon");
    expect(msg).toContain("Stop whatever is listening on it");
    // Telling someone to run `abg kill` in "the other project" is wrong
    // advice when the holder is some unrelated server.
    expect(msg).not.toContain("abg doctor");
  });
});

describe("probeControlPort", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  function serve(handler: (req: Request) => Response): number {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    const port = server.port;
    if (port === undefined) throw new Error("test server did not bind a port");
    return port;
  }

  test("identifies an AgentBridge daemon and reads its identity", async () => {
    const port = serve(() =>
      Response.json({ proxyUrl: "ws://127.0.0.1:1", projectId: "def67890", pid: 4242 }),
    );

    expect(await probeControlPort(port)).toEqual({
      kind: "agentbridge",
      projectId: "def67890",
      pid: 4242,
    });
  });

  test("reports a pre-0.7 daemon's id as undefined, not null", async () => {
    // The difference decides whether the daemon is trusted on an
    // upgrade: absent means "too old to say", null means "no project".
    const port = serve(() => Response.json({ proxyUrl: "ws://127.0.0.1:1", pid: 7 }));
    const holder = await probeControlPort(port);

    expect(holder.kind).toBe("agentbridge");
    expect(holder).toHaveProperty("projectId", undefined);
  });

  test("an HTTP server that is not ours is unknown, not free", async () => {
    const port = serve(() => Response.json({ hello: "world" }));
    expect(await probeControlPort(port)).toEqual({ kind: "unknown" });
  });

  test("a non-200 answer is not treated as a daemon", async () => {
    const port = serve(() => new Response("nope", { status: 500 }));
    expect(await probeControlPort(port)).toEqual({ kind: "unknown" });
  });

  test("a listening socket that does not speak HTTP is unknown", async () => {
    // The fetch fails, so the raw-connect fallback is what answers here.
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    });
    try {
      expect(await probeControlPort(tcp.port)).toEqual({ kind: "unknown" });
    } finally {
      tcp.stop(true);
    }
  });

  test("a port nobody holds is free", async () => {
    // Bind and release, so the port is known-unused rather than guessed.
    const scratch = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = scratch.port!;
    scratch.stop(true);

    expect(await probeControlPort(port)).toEqual({ kind: "free" });
  }, 10_000);
});
