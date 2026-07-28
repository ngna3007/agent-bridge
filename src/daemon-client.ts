import { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
} from "./control-protocol";
import type {
  ClaudeDeliveryHint,
  ControlClientMessage,
  ControlServerMessage,
  DaemonStatus,
  ReplyOutcome,
} from "./control-protocol";

interface DaemonClientEvents {
  /**
   * Codex → Claude message arrived. The second tuple slot is the
   * daemon's delivery hint: "push" (or absent) means surface to
   * Claude immediately via the MCP channel; "queue" means stash in
   * the ClaudeAdapter's pull queue and let Claude reach for it via
   * get_messages.
   */
  codexMessage: [BridgeMessage, ClaudeDeliveryHint | undefined];
  disconnect: [];
  rejected: [number];
  status: [DaemonStatus];
}

let nextSocketId = 0;

/** How long to wait for the daemon to accept a control connection. */
const CONNECT_TIMEOUT_MS = 5000;

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private wsId: number = 0; // Track socket identity for debugging
  private nextRequestId = 1;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: ReplyOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly url: string) {
    super();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log(`connect() skipped — ws#${this.wsId} already OPEN`);
      return;
    }

    // Close any lingering socket in non-OPEN state to avoid orphans
    if (this.ws) {
      const state = this.ws.readyState;
      this.log(`connect() closing lingering ws#${this.wsId} (readyState=${state})`);
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const socketId = ++nextSocketId;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      // A connect to a dead daemon is only fast when the host answers
      // with RST. Where the SYN is dropped instead (WSL2 behind the
      // Windows firewall), this socket sits in CONNECTING for the
      // kernel's full SYN-retry budget — over two minutes of a Claude
      // session hanging with no explanation. The daemon is on loopback:
      // if it has not accepted in five seconds, it is not there.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`Timed out connecting to AgentBridge daemon at ${this.url}`));
      }, CONNECT_TIMEOUT_MS);

      const settle = (action: () => void) => {
        settled = true;
        clearTimeout(timer);
        action();
      };

      ws.onopen = () => {
        settle(() => {
          this.ws = ws;
          this.wsId = socketId;
          this.attachSocketHandlers(ws, socketId);
          this.log(`ws#${socketId} opened and attached`);
          resolve();
        });
      };

      ws.onerror = () => {
        if (settled) return;
        settle(() => reject(new Error(`Failed to connect to AgentBridge daemon at ${this.url}`)));
      };

      ws.onclose = () => {
        if (settled) return;
        settle(() =>
          reject(new Error(`AgentBridge daemon closed the connection during startup (${this.url})`)),
        );
      };
    });
  }

  attachClaude() {
    // Declare who we are: the daemon refuses a frontend from another
    // project rather than wiring it to the wrong Codex.
    this.send({ type: "claude_connect", projectId: process.env.AGENTBRIDGE_PROJECT_ID ?? null });
  }

  async attachClaudeAndWaitForStatus(timeoutMs = 1000): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.off("status", onStatus);
        this.off("rejected", onRejected);
        this.off("disconnect", onDisconnect);
      };

      const finish = (value: boolean) => {
        cleanup();
        resolve(value);
      };

      const onStatus = () => finish(true);
      const onRejected = () => finish(false);
      const onDisconnect = () => finish(false);

      this.on("status", onStatus);
      this.on("rejected", onRejected);
      this.on("disconnect", onDisconnect);

      timer = setTimeout(() => {
        finish(false);
      }, timeoutMs);

      try {
        this.attachClaude();
      } catch {
        finish(false);
      }
    });
  }

  async disconnect() {
    if (!this.ws) return;

    try {
      this.send({ type: "claude_disconnect" });
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  async sendReply(message: BridgeMessage, requireReply?: boolean): Promise<ReplyOutcome> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "AgentBridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for AgentBridge daemon reply." });
      }, 15000);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "claude_to_codex",
        requestId,
        message,
        ...(requireReply ? { requireReply: true } : {}),
      });
    });
  }

  private attachSocketHandlers(ws: WebSocket, socketId: number) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      let message: ControlServerMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      switch (message.type) {
        case "codex_to_claude":
          this.emit("codexMessage", message.message, message.deliveryHint);
          return;
        case "claude_to_codex_result": {
          const pending = this.pendingReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingReplies.delete(message.requestId);
          pending.resolve({
            success: message.success,
            error: message.error,
            queued: message.queued,
            note: message.note,
          });
          return;
        }
        case "status":
          this.emit("status", message.status);
          return;
      }
    };

    ws.onclose = (event) => {
      const isCurrent = this.ws === ws;
      this.log(`ws#${socketId} onclose (code=${event.code}, reason=${event.reason || "none"}, isCurrent=${isCurrent}, currentWsId=${this.wsId})`);
      if (isCurrent) {
        this.ws = null;
        this.rejectPendingReplies("AgentBridge daemon disconnected.");
        if (
          event.code === CLOSE_CODE_REPLACED ||
          event.code === CLOSE_CODE_EVICTED_STALE ||
          event.code === CLOSE_CODE_PROBE_IN_PROGRESS
        ) {
          this.emit("rejected", event.code);
        } else {
          this.emit("disconnect");
        }
      }
      // If this.ws !== ws, this socket was replaced by a newer connection —
      // don't emit "disconnect" or it will trigger a reconnect loop.
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private rejectPendingReplies(error: string) {
    for (const [requestId, pending] of this.pendingReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
      this.pendingReplies.delete(requestId);
    }
  }

  private send(message: ControlClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("AgentBridge daemon socket is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }

  private log(msg: string) {
    process.stderr.write(`[${new Date().toISOString()}] [DaemonClient] ${msg}\n`);
  }
}
