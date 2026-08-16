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

import { Schema } from "effect";
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

export const jsonOk = (payload: RpcEnvelope["payload"]) => Response.json({ ok: true, payload });

export const jsonError = (kind: string, message: string) =>
  Response.json({ error: { kind, message }, ok: false }, { status: 400 });

/** The error's discriminator for the envelope: tagged errors keep their kind. */
const errorKindOf = (cause: unknown) => {
  if (cause instanceof SessionHostError) {
    return cause.kind;
  }
  if (cause instanceof RegistryError) {
    return cause.op ?? "registry";
  }
  if (cause instanceof HubError) {
    return cause.kind;
  }
  return "malformed";
};

/** The envelope's error for any failure crossing the fetch boundary. */
export const rpcErrorOf = (cause: unknown) => ({
  kind: errorKindOf(cause),
  message: cause instanceof Error ? cause.message : String(cause),
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
    report: Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      sessionId: Schema.optionalKey(Schema.Union([Schema.Null, Schema.String])),
      state: Schema.optionalKey(ThreadState),
      tailSeq: Schema.optionalKey(Schema.Number),
    }),
    threadId: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "type" })),
  Schema.TaggedStruct("sessionEvent", {
    event: Schema.Unknown,
    tailSeq: Schema.Number,
    threadId: Schema.String,
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
