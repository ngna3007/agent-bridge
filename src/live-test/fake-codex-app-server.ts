#!/usr/bin/env bun
/**
 * A stand-in for `codex app-server`, for tests that need turn timing
 * they control.
 *
 * The reply outbox only engages while a Codex turn is running, so
 * proving it works means holding a turn open, replying into the gap,
 * and watching the injection land after the turn ends. Against a real
 * app-server that window is whatever the model happens to take, which
 * makes the test both slow and racy — and it spends tokens to exercise
 * wiring that has nothing to do with the model.
 *
 * This server speaks the subset of the app-server protocol the adapter
 * actually reads (see `handleServerNotification` in codex-adapter.ts):
 *
 *   in    initialize, initialized, thread/start, thread/resume, turn/start
 *   out   turn/started, item/started, item/agentMessage/delta,
 *         item/completed, turn/completed
 *
 * Turn length is `FAKE_TURN_MS` (default 1500). A `turn/start` whose
 * text contains `@@HOLD@@` runs long (`FAKE_HOLD_MS`, default 8000)
 * so a test can reply into a known-open window. The agent message it
 * emits echoes the injected text, so a harness can assert that what
 * Claude sent is what Codex received.
 *
 * Everything between this and Claude — daemon, adapter, control WS,
 * MCP server — is production code.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { listen: { type: "string" } },
  allowPositionals: true,
});

// `codex app-server --listen ws://127.0.0.1:PORT`
const listen = values.listen ?? "ws://127.0.0.1:4500";
const port = Number(new URL(listen).port);
if (!Number.isFinite(port) || port <= 0) {
  console.error(`fake-codex: cannot parse a port from --listen ${listen}`);
  process.exit(2);
}

const TURN_MS = Number(process.env.FAKE_TURN_MS ?? 1500);
const HOLD_MS = Number(process.env.FAKE_HOLD_MS ?? 8000);
const REPLY_PREFIX = process.env.FAKE_REPLY_PREFIX ?? "[REPLY] echo: ";

let threadSeq = 0;
let turnSeq = 0;
let itemSeq = 0;
/** Turn ids started but not yet completed. Mirrors the real server's one-turn-at-a-time rule. */
const activeTurns = new Set<string>();

/** Every `turn/start` text this server received, in order. The harness asserts on it. */
const received: string[] = [];

function log(msg: string) {
  console.error(`[fake-codex] ${msg}`);
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // The adapter's own readiness probe hits /healthz over HTTP; the
    // TUI (and the adapter's proxy) upgrade on the same port.
    if (srv.upgrade(req)) return undefined;
    return new Response("fake-codex: expected a websocket upgrade", { status: 400 });
  },
  websocket: {
    open() {
      log("client connected");
    },
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
      const notify = (method: string, params: unknown) =>
        ws.send(JSON.stringify({ method, params }));

      switch (msg.method) {
        case "initialize":
          reply({ userAgent: { name: "fake-codex", version: "0.0.1" } });
          return;

        case "initialized":
          return; // notification

        case "thread/start":
        case "thread/resume": {
          const id = `thread_fake_${++threadSeq}`;
          log(`${msg.method} -> ${id}`);
          reply({ thread: { id } });
          return;
        }

        case "turn/start": {
          const text = (msg.params?.input ?? [])
            .filter((i: any) => i?.type === "text")
            .map((i: any) => i.text)
            .join("");
          received.push(text);

          if (activeTurns.size > 0) {
            // The real server rejects a concurrent turn. The adapter
            // never gets here (it refuses first), but a fake that
            // accepted would hide a regression in that refusal.
            log(`turn/start REJECTED, ${activeTurns.size} turn(s) already active`);
            ws.send(JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: "a turn is already running on this thread" },
            }));
            return;
          }

          const turnId = `turn_fake_${++turnSeq}`;
          activeTurns.add(turnId);
          const holds = text.includes("@@HOLD@@");
          const durationMs = holds ? HOLD_MS : TURN_MS;
          log(`turn/start ${turnId} (${holds ? "HOLD " : ""}${durationMs}ms): ${text.slice(0, 80)}`);

          reply({ turn: { id: turnId } });
          notify("turn/started", { turn: { id: turnId } });

          const itemId = `item_fake_${++itemSeq}`;
          notify("item/started", { item: { type: "agentMessage", id: itemId } });

          setTimeout(() => {
            const answer = `${REPLY_PREFIX}${text}`;
            notify("item/agentMessage/delta", { itemId, delta: answer });
            notify("item/completed", {
              item: { type: "agentMessage", id: itemId, content: [{ type: "text", text: answer }] },
            });
            activeTurns.delete(turnId);
            notify("turn/completed", { turn: { id: turnId } });
            log(`turn/completed ${turnId}`);
          }, durationMs);
          return;
        }

        default:
          // Unknown request: answer so nothing upstream hangs on it.
          if (msg.id !== undefined) reply({});
          return;
      }
    },
    close() {
      log("client disconnected");
    },
  },
});

log(`listening on ws://127.0.0.1:${server.port} (turn ${TURN_MS}ms, hold ${HOLD_MS}ms)`);

// A test that wants to know what Codex was actually asked can read this
// on shutdown rather than scraping the log.
process.on("SIGTERM", () => {
  console.error(`[fake-codex] received-turns: ${JSON.stringify(received)}`);
  process.exit(0);
});
