/**
 * The wire transport's unit tests: JSONL framing over WebSocket —
 * `serializeFrame`/`parseFrame` (one JSON object per line, blank lines
 * ignored) and `decodeFrame` (text passes through; binary views decode;
 * Blobs are rejected because frames are text and the client sets
 * `binaryType` to `arraybuffer`).
 */

import { describe, expect, it } from "vitest";

import { decodeFrame, parseFrame, serializeFrame, WireFrameError } from "../src/index.ts";

describe("decodeFrame", () => {
  it("passes text through", () => {
    expect(decodeFrame("hello")).toBe("hello");
  });

  it("decodes an ArrayBuffer", () => {
    expect(decodeFrame(new TextEncoder().encode("hi").buffer)).toBe("hi");
  });

  it("decodes the exact view of a TypedArray slice", () => {
    const bytes = new Uint8Array([0x00, 0x68, 0x69, 0x00]);
    expect(decodeFrame(bytes.subarray(1, 3))).toBe("hi");
  });

  it("decodes a Node Buffer (a Uint8Array view)", () => {
    expect(decodeFrame(Buffer.from("héllo"))).toBe("héllo");
  });

  it("decodes a DataView over the exact byte range", () => {
    const bytes = new TextEncoder().encode("view");
    expect(decodeFrame(new DataView(bytes.buffer, 1, bytes.byteLength - 2))).toBe("ie");
  });

  it("rejects Blobs (frames are text; the client sets binaryType to arraybuffer)", () => {
    expect(() => decodeFrame(new Blob(["hello"]))).toThrow(WireFrameError);
  });

  it("rejects anything that is neither text nor a binary view", () => {
    expect(() => decodeFrame({})).toThrow(WireFrameError);
    expect(() => decodeFrame(null)).toThrow(WireFrameError);
  });
});

describe("parseFrame", () => {
  it("parses one JSON line", () => {
    expect(parseFrame('{"a":1}\n')).toEqual({ a: 1 });
  });

  it("ignores blank lines", () => {
    expect(parseFrame("")).toBeUndefined();
    expect(parseFrame("\n")).toBeUndefined();
    expect(parseFrame("   \n")).toBeUndefined();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseFrame("not json")).toThrow(SyntaxError);
  });
});

describe("serializeFrame", () => {
  it("serializes one JSON object as a single line", () => {
    expect(serializeFrame({ a: 1 })).toBe('{"a":1}\n');
  });
});
