/**
 * The wire transport's property tests (transport.test.ts): JSONL framing
 * over WebSocket, exercised as properties — `serializeFrame`/`parseFrame`
 * (one JSON object per line, blank lines ignored) and `decodeFrame` (text
 * passes through; binary views decode; Blobs are rejected because frames
 * are text and the client sets `binaryType` to `arraybuffer`).
 *
 * The framing contract is total: for ANY input, parseFrame either yields
 * the JSON value of a non-blank line or throws SyntaxError, and decodeFrame
 * either passes the exact text/binary payload through or throws
 * WireFrameError — the properties pin the whole surface, not just the
 * happy paths.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { decodeFrame, parseFrame, serializeFrame, WireFrameError } from "../src/index.ts";

/** JSON cannot represent -0 (it stringifies to "0"); the wire round-trip
 *  collapses it, so compare modulo that collapse. */
const normalize = (value: unknown) => {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalize(nested),
      ]),
    );
  }
  return value;
};

describe("serializeFrame/parseFrame", () => {
  it("round-trips any JSON value as one line", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(normalize(parseFrame(serializeFrame(value)))).toEqual(normalize(value));
      }),
    );
  });
});

describe("parseFrame", () => {
  it("parses one JSON line, ignores blank lines, and rejects anything else", () => {
    // The total spec: a line is blank when trimmed; otherwise it is either
    // valid JSON (yielded as-is) or malformed (SyntaxError, never anything
    // else).
    fc.assert(
      fc.property(fc.string(), (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          expect(parseFrame(line)).toBeUndefined();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined) {
          expect(() => parseFrame(line)).toThrow(SyntaxError);
        } else {
          expect(parseFrame(line)).toEqual(parsed);
        }
      }),
    );
  });
});

describe("decodeFrame", () => {
  it("passes any text through unchanged", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(decodeFrame(text)).toBe(text);
      }),
    );
  });

  it("decodes text embedded at any offset of a binary buffer", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 16 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 16 }),
        (text, prefix, suffix) => {
          const encoded = new TextEncoder().encode(text);
          const bytes = new Uint8Array([...prefix, ...encoded, ...suffix]);
          // The exact view of the text, wherever it sits in the buffer.
          const view = bytes.subarray(prefix.length, prefix.length + encoded.length);
          expect(decodeFrame(view)).toBe(text);
          // The same bytes as an ArrayBuffer and as a DataView.
          expect(decodeFrame(bytes.buffer.slice(prefix.length, prefix.length + encoded.length))).toBe(
            text,
          );
          expect(
            decodeFrame(new DataView(bytes.buffer, prefix.length, encoded.length)),
          ).toBe(text);
        },
      ),
    );
  });

  it("decodes a Node Buffer (a Uint8Array view)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(decodeFrame(Buffer.from(text))).toBe(text);
      }),
    );
  });

  it("rejects Blobs and anything that is neither text nor a binary view", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(new Blob(["hello"])),
          fc.constant(42),
          fc.constant(null),
          fc.constant(true),
          fc.constant({}),
          fc.constant([]),
        ),
        (data) => {
          expect(() => decodeFrame(data)).toThrow(WireFrameError);
        },
      ),
    );
  });
});
