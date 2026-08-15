/**
 * The console's rendering vocabulary (projection.ts): schema-typed views of
 * pi's session shapes, decoded ONLY in the console (ADR 0005 — the wire
 * keeps pi's types opaque; the console projects what it renders).
 *
 * Field lists are exactly what format.ts reads today. Optional fields on
 * purpose: pi's entries and messages vary wildly by `type`; the console
 * renders what is present. The event projection replaces the wire's TS-only
 * `SessionWireEvent` with a tagged union decoded at the subscription
 * boundary — unknown tags degrade to the explicit `unhandled` variant
 * instead of a silent default.
 */

import { Effect, Option, Result, Schema as S } from "effect";
import { SakuSessionEvent } from "@saku/wire";

const ContentBlock = S.Struct({
  type: S.optional(S.String),
  text: S.optional(S.String),
  thinking: S.optional(S.String),
  id: S.optional(S.String),
  name: S.optional(S.String),
  arguments: S.optional(S.Unknown),
});

export const MessageProjection = S.Struct({
  role: S.optional(S.String),
  content: S.optional(S.Union([S.String, S.Array(ContentBlock)])),
  toolCallId: S.optional(S.String),
  toolName: S.optional(S.String),
  isError: S.optional(S.Boolean),
  stopReason: S.optional(S.String),
  errorMessage: S.optional(S.String),
  /** pi's per-request usage (the context badge's source); decoded in
   *  presentation.ts, never re-schema'd (ADR 0005). */
  usage: S.optional(S.Unknown),
});
export type MessageProjection = S.Schema.Type<typeof MessageProjection>;

export const EntryProjection = S.Struct({
  id: S.optional(S.String),
  seq: S.optional(S.Number),
  type: S.optional(S.String),
  message: S.optional(MessageProjection),
  provider: S.optional(S.String),
  modelId: S.optional(S.String),
  thinkingLevel: S.optional(S.String),
  activeToolNames: S.optional(S.Unknown),
  summary: S.optional(S.Unknown),
});
export type EntryProjection = S.Schema.Type<typeof EntryProjection>;

/** pi's event discriminant on the wire (`type` on the JSON, `_tag` after decode). */
export const EventTag = S.Struct({ type: S.String });

/** Session events as the console folds them (Match reads `_tag`). */
export const SessionEventProjection = S.Union([
  S.TaggedStruct("entry_appended", { entry: EntryProjection }),
  S.TaggedStruct("message_start", { message: MessageProjection }),
  S.TaggedStruct("message_end", { message: MessageProjection }),
  S.TaggedStruct("message_update", { message: MessageProjection }),
  S.TaggedStruct("tool_execution_start", { toolCallId: S.String, toolName: S.String }),
  S.TaggedStruct("tool_execution_update", { toolCallId: S.String, partialResult: S.Unknown }),
  S.TaggedStruct("tool_execution_end", {
    toolCallId: S.String,
    isError: S.Boolean,
    result: S.Unknown,
  }),
  S.TaggedStruct("settled", {}),
  S.TaggedStruct("compaction_start", { reason: S.Literals(["manual", "threshold", "overflow"]) }),
  S.TaggedStruct("compaction_end", {
    reason: S.Literals(["manual", "threshold", "overflow"]),
    result: S.optional(S.Unknown),
    aborted: S.Boolean,
    errorMessage: S.optional(S.String),
  }),
  /** The explicit long tail: anything the projection does not know. */
  S.TaggedStruct("unhandled", { event: S.Unknown }),
]);
export type SessionEventProjection = S.Schema.Type<typeof SessionEventProjection>;

const DECODE_TAG = S.decodeUnknownOption(EventTag);
const DECODE_EVENT = S.decodeUnknownOption(SessionEventProjection);
const DECODE_SAKU = S.decodeUnknownOption(SakuSessionEvent);

const unhandled = (event: unknown): SessionEventProjection => ({ _tag: "unhandled", event });

/**
 * Decode a raw wire event into the projection (`_tag` discriminant, for
 * Match). Saku's own events validate against their wire schema — the
 * wire's `type` decodes straight to the code's `_tag`. pi's events stay
 * opaque (ADR 0005): their `type` is read off and retagged. Anything else
 * — unknown tags, malformed payloads, non-records — becomes `unhandled`.
 * Never throws.
 */
export const decodeSessionEvent = (event: unknown) => {
  const saku = DECODE_SAKU(event);
  if (Option.isSome(saku)) {
    return Option.getOrElse(DECODE_EVENT(saku.value), () => unhandled(event));
  }
  const tagged = DECODE_TAG(event);
  if (Option.isNone(tagged) || typeof event !== "object" || event === null) {
    return unhandled(event);
  }
  const retagged = { ...(event as Record<string, unknown>), _tag: tagged.value.type };
  return Option.getOrElse(DECODE_EVENT(retagged), () => unhandled(event));
};

/**
 * Decode one trail entry; undecodable entries are dropped (the projection
 * is fully optional-fielded, so this only fails on non-records — bounded,
 * never crashes the trail).
 */
export const decodeEntry = Effect.fn("decodeEntry")(function* (entry: unknown) {
  const decoded = Result.try(() => S.decodeUnknownSync(EntryProjection)(entry));
  if (Result.isFailure(decoded)) {
    yield* Effect.logWarning("dropping undecodable trail entry", decoded.failure);
    return undefined;
  }
  return decoded.success;
});
