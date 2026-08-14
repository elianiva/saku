/**
 * The thread submodel's commands (thread/command.ts): the pane's wire
 * operations as foldkit Commands landing thread messages. Errors never
 * escape as defects — every command body fails only with `WireError`, and
 * the shared `catchWireError` (root/command.ts) projects it into a `*Failed`
 * message so the pane can show it.
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import { catchWireError } from "../root/command.ts";
import { Wire } from "../wire.ts";
import {
  AbortDone,
  PromptAcked,
  ScrollDone,
  SendFailed,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";
import { decodeEntry, type EntryProjection } from "./projection.ts";

/** Load a thread's entry trail (reads never start a session, ADR 0004). */
export const LoadTrailCmd = Command.define("LoadTrail", {
  args: { id: S.String },
  messages: [TrailLoaded, TrailFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const result = yield* client.getEntries(id, 0);
        const entries = result.entries
          .map(decodeEntry)
          .filter((entry): entry is EntryProjection => entry !== undefined);
        return TrailLoaded({ entries, tailSeq: result.tailSeq });
      }),
      (error) => TrailFailed({ error: error.message }),
    ),
});

/** Send the composer's text to the thread. */
export const PromptCmd = Command.define("Prompt", {
  args: { id: S.String, text: S.String },
  messages: [PromptAcked, SendFailed],
  execute: ({ id, text }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        yield* client.prompt(id, text);
        return PromptAcked();
      }),
      (error) => SendFailed({ message: error.message }),
    ),
});

/** Abort the in-flight run; a failed abort is already-done, not an error. */
export const AbortCmd = Command.define("Abort", {
  args: { id: S.String },
  messages: [AbortDone],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        yield* client.abort(id);
        return AbortDone();
      }),
      () => AbortDone(),
    ),
});

/**
 * Scroll the trail to the bottom when the user is near it (they are
 * following the run). update fires it directly when a fold grew the
 * scrollable view; the command performs the DOM touch and lands on a
 * no-op message.
 */
export const ScrollTrailCmd = Command.define("ScrollTrail", {
  messages: [ScrollDone],
  execute: Effect.sync(() => {
    const el = document.getElementById("trail");
    if (el !== null) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
    return ScrollDone();
  }),
});
