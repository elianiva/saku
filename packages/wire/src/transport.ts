/**
 * The wire's transport feature: JSONL framing over WebSocket.
 *
 * One JSON object per message, serialized as a single line (`\n`-terminated —
 * pi's framing habit, so a raw dump of the connection is a log of frames).
 * Messages arrive whole (no chunk reassembly is needed over WS); `decodeFrame`
 * accepts text and binary messages so the same code runs in browsers (Blob
 * binary type is rejected — frames are text) and on Node (Buffer/ArrayBuffer).
 */

import { Schema as S } from "effect";

import type { Hello } from "./hello.ts";
import type { WireCommand, WireEvent } from "./envelope.ts";
import { opaque } from "./opaque.ts";

/** A JSON value: what a frame line carries (JSON.parse/stringify's contract). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  // `undefined` props are admitted: JSON.stringify drops them, and
  // schema structs with optional fields (exactOptionalPropertyTypes)
  // type those as `T | undefined` at serialize time.
  | { readonly [key: string]: JsonValue | undefined };

/** A raw inbound WebSocket message, before normalization: text or binary. */
export type SocketMessage = string | ArrayBuffer | ArrayBufferView | Blob;

/** Everything the transport frames: the wire's own vocabulary, or any JSON value. */
export type WireFrame = WireCommand | WireEvent | Hello;

// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = S.TaggedError;

/** A malformed wire frame (the transport's decode failure). */
export class WireFrameError extends tagged<WireFrameError>()("WireFrameError", {
  message: S.String,
}) {}

/** Serialize one frame as a JSON line, ready for `ws.send`. */
export const serializeFrame = (value: JsonValue | WireFrame) => `${JSON.stringify(value)}\n`;

const TEXT_DECODER = new TextDecoder();

/** Whether the raw message is a text frame. */
const isTextFrame = (data: SocketMessage): data is string => typeof data === "string";

/** Whether a raw message is a wire frame payload (text or a binary view). */
export const isSocketMessage = S.is(opaque<SocketMessage>());

/**
 * Normalize an incoming WebSocket message to its text payload. Frames are
 * text; binary frames are decoded for robustness. Blobs (a browser default
 * binary type) are rejected.
 */
export const decodeFrame = (data: SocketMessage): string => {
  if (data instanceof ArrayBuffer) {
    return TEXT_DECODER.decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return TEXT_DECODER.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (isTextFrame(data)) {
    return data;
  }
  throw new WireFrameError({
    message: "wire frames must arrive as text or binary; got a Blob",
  });
};

const decodeJson = S.decodeUnknownSync(opaque<JsonValue>());

/** Parse one frame line; returns the decoded JSON or undefined for blank lines. */
export const parseFrame = (line: string): JsonValue | undefined => {
  const text = line.trim();
  if (text.length === 0) {
    return undefined;
  }
  return decodeJson(JSON.parse(text));
};
