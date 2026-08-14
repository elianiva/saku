/**
 * The DO-to-DO protocol (do-protocol.ts): the single definition of the
 * JSON contract between the hub DO and the thread DOs — the push
 * payloads a thread sends to the hub (`HubPushSchema`), the thread
 * endpoints' payload schemas (/create, /set-env-handle, /command), the
 * RPC envelope, and the shared response helpers.
 *
 * The hub drives threads through `threadRpc` and the thread DOs push
 * reports/events/idle-stop firings back through `hubRpc` (`/push`) —
 * plain JSON over `fetch`, no alchemy runtime (the same classes run
 * under Cloudflare and celld). Everything that crosses the seam is
 * schema-typed here and decoded at the boundary; decode failures answer
 * the envelope's error response. Tagged errors keep their discriminator
 * across the seam: the error envelope carries `{ kind, message }` (a
 * SessionHostError's kind, a RegistryError's op, a HubError's kind, or
 * "malformed"), so the caller never matches on message text.
 */

import { Effect, Option, Schema } from "effect";
import { SessionCommand, ThreadState } from "@saku/wire";
import { EnvHandle } from "@saku/env/remote";
import { HubError } from "@saku/hub/core";
import { RegistryError, SessionHostError, ThreadRecordSchema } from "@saku/worker/isolate";

/** A JSON response from a DO endpoint (what the caller parses). */
export interface RpcEnvelope {
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly kind: string; readonly message: string };
}

export const jsonOk = (payload: unknown): Response => Response.json({ ok: true, payload });

export const jsonError = (kind: string, message: string): Response =>
  Response.json({ ok: false, error: { kind, message } }, { status: 400 });

/** The error's discriminator for the envelope: tagged errors keep their kind. */
const errorKindOf = (error: unknown): string => {
  if (error instanceof SessionHostError) return error.kind;
  if (error instanceof RegistryError) return error.op ?? "registry";
  if (error instanceof HubError) return error.kind;
  return "malformed";
};

/** The envelope's error for any failure crossing the fetch boundary. */
export const rpcErrorOf = (
  error: unknown,
): { readonly kind: string; readonly message: string } => ({
  kind: errorKindOf(error),
  message: error instanceof Error ? error.message : String(error),
});

/**
 * The `/push` payloads, validated at the boundary: the push channel
 * discriminates on `type`, while TaggedStruct decodes `_tag` —
 * `encodeKeys` renames the encoded key so the wire shape validates and
 * the decoded type stays `_tag`-tagged for the hub's Match below. The
 * session event rides as opaque `unknown` — pi's event types stay opaque
 * on the wire (ADR 0005), the hub forwards them uninterpreted. The
 * report fields use `optionalKey` (exact optional) so the decoded report
 * matches `WorkerReport` under `exactOptionalPropertyTypes`.
 */
export const HubPushSchema = Schema.Union([
  Schema.TaggedStruct("report", {
    threadId: Schema.String,
    report: Schema.Struct({
      state: Schema.optionalKey(ThreadState),
      sessionId: Schema.optionalKey(Schema.Union([Schema.Null, Schema.String])),
      name: Schema.optionalKey(Schema.String),
      tailSeq: Schema.optionalKey(Schema.Number),
    }),
  }).pipe(Schema.encodeKeys({ _tag: "type" })),
  Schema.TaggedStruct("sessionEvent", {
    threadId: Schema.String,
    event: Schema.Unknown,
    tailSeq: Schema.Number,
  }).pipe(Schema.encodeKeys({ _tag: "type" })),
  Schema.TaggedStruct("idleStopFired", { threadId: Schema.String }).pipe(
    Schema.encodeKeys({ _tag: "type" }),
  ),
]);

/** The push payloads a thread DO sends to the hub DO (the wire shape, `type`-tagged). */
export type HubPush = Schema.Codec.Encoded<typeof HubPushSchema>;

export const decodeHubPush = Schema.decodeUnknownOption(HubPushSchema);

/** /create: the hub's record for this thread (persisted in DO storage). */
export const CreatePayload = Schema.Struct({ record: ThreadRecordSchema });
export type CreatePayload = Schema.Schema.Type<typeof CreatePayload>;
export const decodeCreatePayload = Schema.decodeUnknownOption(CreatePayload);

/** /set-env-handle: the persisted env handle (null clears it). */
export const SetEnvHandlePayload = Schema.Struct({
  handle: Schema.Union([EnvHandle, Schema.Null]),
});
export type SetEnvHandlePayload = Schema.Schema.Type<typeof SetEnvHandlePayload>;
export const decodeSetEnvHandlePayload = Schema.decodeUnknownOption(SetEnvHandlePayload);

/** /command: one session command. */
export const CommandPayload = Schema.Struct({ command: SessionCommand });
export type CommandPayload = Schema.Schema.Type<typeof CommandPayload>;
export const decodeCommandPayload = Schema.decodeUnknownOption(CommandPayload);

/** Parse a request body and decode it against a payload decoder; none on malformed JSON or shape. */
export const readBody = <A>(
  request: Request,
  decode: (body: unknown) => Option.Option<A>,
): Promise<Option.Option<A>> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json() as Promise<unknown>,
      catch: () => undefined,
    }).pipe(Effect.flatMap((body) => Effect.sync(() => decode(body)))),
  );
