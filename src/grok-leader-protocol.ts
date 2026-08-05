/**
 * Grok's leader socket protocol — the envelope ACP travels inside.
 *
 * A leader is a shared agent backend, one per machine by default at
 * `~/.grok/leader.sock`, and every `grok` process is a client of it.
 * The socket does not carry ACP directly. It carries length-prefixed
 * JSON control frames, and ACP is one frame type among them:
 *
 *   [u32 big-endian byte length][JSON]
 *
 *   {"type":"register","client_type":"…","mode":"stdio","capabilities":{…}}
 *   {"type":"registered","client_id":8,"ready":true,"leader_protocol_version":1,…}
 *   {"type":"acp","payload":"<one ACP JSON-RPC message, JSON-encoded as a string>"}
 *
 * Measured against grok 0.2.118 by proxying a real client through a unix
 * socket and decoding both directions. The `payload` really is a *string*
 * holding JSON, not a nested object — so reading it takes two parses.
 *
 * Everything above the envelope lives in `./grok-acp`, which is written
 * against the ACP standard and knows nothing about leaders.
 */

/** Frames whose meaning the bridge depends on. Others pass through untouched. */
export type LeaderFrameType = "register" | "registered" | "acp";

export interface LeaderFrame {
  type: LeaderFrameType | string;
  /** Present on `acp` frames: one ACP JSON-RPC message, JSON-encoded. */
  payload?: string;
  /** Present on `registered`: the id the leader assigned this client. */
  client_id?: number;
  [key: string]: unknown;
}

/** Longest frame we will buffer before treating the stream as garbage. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Raised when the peer sends a length prefix we refuse to allocate for. */
export class LeaderProtocolError extends Error {}

/** Wrap a control frame for the wire. */
export function encodeLeaderFrame(frame: LeaderFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Wrap one ACP JSON-RPC message as an `acp` frame. */
export function encodeAcpFrame(message: unknown): Buffer {
  return encodeLeaderFrame({ type: "acp", payload: JSON.stringify(message) });
}

/**
 * The ACP message inside a frame, or null when there is none.
 *
 * Null covers three cases that are all "nothing for the ACP layer here":
 * a non-`acp` frame, a missing payload, and a payload that does not
 * parse. The last one is not worth throwing over — a leader that starts
 * emitting a payload shape we cannot read should cost us that message,
 * not the connection carrying the human's session.
 */
export function readAcpFrame(frame: LeaderFrame): unknown | null {
  if (frame.type !== "acp" || typeof frame.payload !== "string") return null;
  try {
    return JSON.parse(frame.payload);
  } catch {
    return null;
  }
}

/**
 * The `register` frame a client opens with.
 *
 * `client_type` is free-form and shows up in `grok leader info`, so it is
 * worth being honest in: a human debugging a stuck leader should be able
 * to see that one of its clients is us.
 */
export function registerFrame(clientType: string): Buffer {
  return encodeLeaderFrame({
    type: "register",
    client_type: clientType,
    mode: "stdio",
    capabilities: {
      yolo_mode: false,
      auto_mode: false,
      client_version: "agentbridge",
      code_nav_enabled: false,
      terminal: false,
      fs_read: false,
      fs_write: false,
    },
  });
}

/**
 * Reassemble length-prefixed frames from a byte stream.
 *
 * Stateful because a frame is routinely split across chunks — the
 * leader's MCP-server and announcement blobs are several KB and arrive
 * in pieces — and because two frames just as routinely share one chunk.
 */
export class LeaderFramer {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): LeaderFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: LeaderFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        // Refusing here rather than allocating is the whole point: a
        // desynchronised stream reads a random 4 bytes as a length, and
        // the next thing that happens is a multi-gigabyte allocation.
        throw new LeaderProtocolError(
          `Leader frame claims ${length} bytes, above the ${MAX_FRAME_BYTES} limit`,
        );
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      try {
        frames.push(JSON.parse(body) as LeaderFrame);
      } catch {
        // Same reasoning as `readAcpFrame`: an unreadable frame costs
        // that frame. The stream is still correctly delimited.
      }
    }
    return frames;
  }
}
