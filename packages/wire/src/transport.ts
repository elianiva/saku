/**
 * The wire's transport feature: JSONL framing over WebSocket.
 *
 * One JSON object per message, serialized as a single line (`\n`-terminated —
 * pi's framing habit, so a raw dump of the connection is a log of frames).
 * Messages arrive whole (no chunk reassembly is needed over WS); `decodeFrame`
 * accepts text and binary messages so the same code runs in browsers (Blob
 * binary type is rejected — frames are text) and on Node (Buffer/ArrayBuffer).
 */

/** Serialize one frame as a JSON line, ready for `ws.send`. */
export const serializeFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

const TEXT_DECODER = new TextDecoder();

/**
 * Normalize an incoming WebSocket message to its text payload. Frames are
 * text; binary frames are decoded for robustness. Blobs (a browser default
 * binary type) are rejected.
 */
export const decodeFrame = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return TEXT_DECODER.decode(data);
  // Typed arrays (Node Buffers included) and DataViews: decode the exact view.
  if (ArrayBuffer.isView(data)) {
    return TEXT_DECODER.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new TypeError("wire frames must arrive as text or binary; got a Blob");
};

/** Parse one frame line; returns the decoded JSON or undefined for blank lines. */
export const parseFrame = (line: string): unknown => {
  const text = line.trim();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
};
