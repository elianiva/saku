/**
 * The wire's transport feature: JSONL framing over a byte stream.
 *
 * One JSON object per line, `\n` separated — pi's framing habit (ADR 0001).
 * The reader is chunk-safe: multi-byte UTF-8 sequences split across chunks
 * are reassembled before decoding.
 */

import type { Socket } from "node:net";

/** Incrementally splits an incoming byte stream into complete JSON lines. */
export class JsonLinesReader {
  private readonly onLine: (line: string) => void;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer =
      this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data], this.buffer.length + data.length);

    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      // Tolerate a trailing \r (CRLF from foreign writers); never emit empty lines.
      const text = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
      if (text.length > 0) {
        this.onLine(text.toString("utf8"));
      }
    }
  }
}

/** Serialize one value as a JSON line. Returns false when the socket buffer is full. */
export const writeJsonLine = (socket: Socket, value: unknown): boolean =>
  socket.write(`${JSON.stringify(value)}\n`);

/** Parse one line; returns the decoded JSON or undefined for blank lines. */
export const parseJsonLine = (line: string): unknown => {
  const text = line.trim();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
};
