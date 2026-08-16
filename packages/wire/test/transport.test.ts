/**
 * The wire transport's property tests (transport.test.ts): JSONL framing
 * over WebSocket, exercised as properties — `serializeFrame`/`parseFrame`
 * (one JSON object per line, blank lines ignored) and `decodeFrame` (text
 * passes through; binary views decode; Blobs are rejected because frames
 * are text and the client sets `binaryType` to `arraybuffer`).
 *
 * The framing contract is total: for ANY frame, parseFrame either yields
 * the JSON value of a non-blank line or throws SyntaxError, and decodeFrame
 * either passes the exact text/binary payload through or throws
 * WireFrameError — the properties pin the whole surface, not just the
 * happy paths.
 */

import { describe, expect, it } from "vitest";
import { array, assert, constant, integer, jsonValue, oneof, property, string } from "fast-check";

import { decodeFrame, parseFrame, serializeFrame, WireFrameError } from "../src/index.ts";
import type { JsonValue } from "../src/index.ts";

/** Whether the JSON value is an array (typed, so the mapping stays sound). */
const isJsonArray = (value: JsonValue): value is JsonValue[] => Array.isArray(value);

/** Whether the JSON value is a plain object (not an array). */
const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON cannot represent -0 (it stringifies to "0"); the wire round-trip
 *  collapses it, so compare modulo that collapse. */
const normalize = (value: JsonValue): JsonValue => {
  if (Object.is(value, -0)) {
    return 0;
  }
  if (isJsonArray(value)) {
    return value.map(normalize);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
};

describe("serializeFrame/parseFrame", () => {
  it("round-trips any JSON value as one line", () => {
    assert(
      property(jsonValue(), (value: JsonValue) => {
        const roundTripped = parseFrame(serializeFrame(value));
        expect(roundTripped).toBeDefined();
        if (roundTripped !== undefined) {
          expect(normalize(roundTripped)).toEqual(normalize(value));
        }
      }),
    );
  });
});

describe("parseFrame", () => {
  it("parses one JSON line, ignores blank lines, and rejects anything else", () => {
    // The total spec: a line is blank when trimmed; otherwise it is either
    // valid JSON (yielded as-is) or malformed (SyntaxError, never anything
    // else).
    assert(
      property(string(), (line) => {
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
    assert(
      property(string(), (text) => {
        expect(decodeFrame(text)).toBe(text);
      }),
    );
  });

  it("decodes text embedded at any offset of a binary buffer", () => {
    assert(
      property(
        string(),
        array(integer({ max: 255, min: 0 }), { maxLength: 16 }),
        array(integer({ max: 255, min: 0 }), { maxLength: 16 }),
        (text, prefix, suffix) => {
          const encoded = new TextEncoder().encode(text);
          const bytes = new Uint8Array([...prefix, ...encoded, ...suffix]);
          // The exact view of the text, wherever it sits in the buffer.
          const view = bytes.subarray(prefix.length, prefix.length + encoded.length);
          expect(decodeFrame(view)).toBe(text);
          // The same bytes as an ArrayBuffer and as a DataView.
          expect(
            decodeFrame(bytes.buffer.slice(prefix.length, prefix.length + encoded.length)),
          ).toBe(text);
          expect(decodeFrame(new DataView(bytes.buffer, prefix.length, encoded.length))).toBe(text);
        },
      ),
    );
  });

  it("decodes a Node Buffer (a Uint8Array view)", () => {
    assert(
      property(string(), (text) => {
        expect(decodeFrame(Buffer.from(text))).toBe(text);
      }),
    );
  });

  it("rejects Blobs (the one in-domain payload that is not a frame)", () => {
    assert(
      property(oneof(constant(new Blob(["hello"]))), (blob) => {
        expect(() => decodeFrame(blob)).toThrow(WireFrameError);
      }),
    );
  });
});
