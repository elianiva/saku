/**
 * The opaque-payload boundary (opaque.ts): the ADR 0005 seam where pi's
 * vocabulary crosses the wire unvalidated. The narrow to pi's types happens
 * here, by name, never as a bare `as` in the method bodies — the guard
 * deliberately checks nothing, because re-scheming pi's types is forbidden.
 */

import { Schema as S } from "effect";

/** A schema that accepts any payload and types it as `T` (no-op guard). */
export const opaque = <T>() =>
  S.declare<T>((_u): _u is T => true, {
    description: "opaque payload, carried unvalidated (ADR 0005)",
  });
