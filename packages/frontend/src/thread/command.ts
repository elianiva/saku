/**
 * The thread submodel's commands (thread/command.ts): the pane's wire
 * operations as foldkit Commands landing thread messages. Errors never
 * escape as defects — every command body fails only with `WireError` and
 * catches the tag itself, projecting it into a `*Failed` message so the
 * pane can show it.
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import { Wire } from "../wire.ts";
import {
  AbortDone,
  CompactionFailed,
  CompactionFinished,
  CreateFailed,
  ModelSet,
  ModelSetFailed,
  ModelsListed,
  ModelsListFailed,
  PromptAcked,
  SendFailed,
  StateFailed,
  StateLoaded,
  ThreadCreated,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";
import { decodeEntry, type EntryProjection } from "./projection.ts";

/** Load a thread's entry trail (reads never start a session, ADR 0004). */ export const LoadTrailCmd =
  Command.define("LoadTrail", {
    args: { id: S.String },
    messages: [TrailLoaded, TrailFailed],
    execute: ({ id }) =>
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const result = yield* client.getEntries(id, 0);
        const decoded = yield* Effect.forEach(result.entries, decodeEntry);
        const entries = decoded.filter((entry): entry is EntryProjection => entry !== undefined);
        return TrailLoaded({ entries, tailSeq: result.tailSeq });
      }).pipe(
        Effect.catchTag("WireError", (error) =>
          Effect.succeed(TrailFailed({ error: error.message })),
        ),
      ),
  });

/** Read the pinned thread's state and registry info — the model badge's
 *  model and the header's state/env line (ADR 0004). The info lands here
 *  because a thread opened mid-run must show its state and the stop
 *  control immediately, not only after the next broadcast. */
export const LoadStateCmd = Command.define("LoadState", {
  args: { id: S.String },
  messages: [StateLoaded, StateFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const [state, info] = yield* Effect.all([client.getState(id), client.getThread(id)]);
      return StateLoaded({ model: state.model, info });
    }).pipe(Effect.catchTag("WireError", () => Effect.succeed(StateFailed()))),
});

/** List the models the thread can switch to (a read — catalog-served, ADR 0004). */
export const ListModelsCmd = Command.define("ListModels", {
  args: { id: S.String },
  messages: [ModelsListed, ModelsListFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const models = yield* client.getAvailableModels(id);
      return ModelsListed({ models });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ModelsListFailed({ error })))),
});

/** Switch the thread's model; the response carries the resolved model. */
export const SetModelCmd = Command.define("SetModel", {
  args: { id: S.String, provider: S.String, modelId: S.String },
  messages: [ModelSet, ModelSetFailed],
  execute: ({ id, provider, modelId }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const model = yield* client.setModel(id, provider, modelId);
      return ModelSet({ model });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(ModelSetFailed({ message: error.message })),
      ),
    ),
});

/** Send the composer's text to the thread. */
export const PromptCmd = Command.define("Prompt", {
  args: { id: S.String, text: S.String },
  messages: [PromptAcked, SendFailed],
  execute: ({ id, text }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.prompt(id, text);
      return PromptAcked();
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(SendFailed({ message: error.message })),
      ),
    ),
});

/** Manual compaction, exposed through the composer's `/compact` palette
 * action. The worker still owns session state and the streamed compaction
 * events; this command only starts the existing wire operation. */
export const CompactCmd = Command.define("Compact", {
  args: { id: S.String },
  messages: [CompactionFinished, CompactionFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.compact(id);
      return CompactionFinished();
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(CompactionFailed({ message: error.message })),
      ),
    ),
});

/** Quick start: create the thread from the composer draft and set it to
 *  work (CONTEXT.md: Quick start). The first prompt provisions the env and
 *  starts the run; the pane watches it through the events. */
export const QuickStartCmd = Command.define("QuickStart", {
  args: { text: S.String },
  messages: [ThreadCreated, CreateFailed],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const created = yield* client.createThread(text, { autoName: true });
      yield* client.prompt(created.id, text);
      const thread = yield* client.getThread(created.id);
      return ThreadCreated({ thread });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(CreateFailed({ message: error.message })),
      ),
    ),
});

/** Abort the in-flight run; a failed abort is already-done, not an error. */
export const AbortCmd = Command.define("Abort", {
  args: { id: S.String },
  messages: [AbortDone],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.abort(id);
      return AbortDone();
    }).pipe(Effect.catchTag("WireError", () => Effect.succeed(AbortDone()))),
});
