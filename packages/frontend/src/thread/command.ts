/**
 * The thread submodel's commands (thread/command.ts): the pane's wire
 * operations as foldkit Commands landing thread messages. Errors never
 * escape as defects — every command body fails only with `WireError`, and
 * the shared `catchWireError` (root/command.ts) projects it into a `*Failed`
 * message so the pane can show it.
 */

import { Effect, Schema as S } from "effect";
import { Command, Render } from "foldkit";

import { catchWireError } from "../root/command.ts";
import { Wire } from "../wire.ts";
import {
  AbortDone,
  CreateFailed,
  ModelSet,
  ModelSetFailed,
  ModelsListed,
  ModelsListFailed,
  PromptAcked,
  ScrollDone,
  SendFailed,
  StateFailed,
  StateLoaded,
  ThreadCreated,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";
import { decodeEntry, type EntryProjection } from "./projection.ts";

/** Load a thread's entry trail (reads never start a session, ADR 0004). */export const LoadTrailCmd = Command.define("LoadTrail", {
  args: { id: S.String },
  messages: [TrailLoaded, TrailFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const result = yield* client.getEntries(id, 0);
        const decoded = yield* Effect.forEach(result.entries, decodeEntry);
        const entries = decoded.filter(
          (entry): entry is EntryProjection => entry !== undefined,
        );
        return TrailLoaded({ entries, tailSeq: result.tailSeq });
      }),
      (error) => TrailFailed({ error: error.message }),
    ),
});

/** Read the pinned thread's state — the model badge's model (ADR 0004). */
export const LoadStateCmd = Command.define("LoadState", {
  args: { id: S.String },
  messages: [StateLoaded, StateFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const state = yield* client.getState(id);
        return StateLoaded({ model: state.model });
      }),
      () => StateFailed(),
    ),
});

/** List the models the thread can switch to (a read — catalog-served, ADR 0004). */
export const ListModelsCmd = Command.define("ListModels", {
  args: { id: S.String },
  messages: [ModelsListed, ModelsListFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const models = yield* client.getAvailableModels(id);
        return ModelsListed({ models });
      }),
      (error) => ModelsListFailed({ error }),
    ),
});

/** Switch the thread's model; the response carries the resolved model. */
export const SetModelCmd = Command.define("SetModel", {
  args: { id: S.String, provider: S.String, modelId: S.String },
  messages: [ModelSet, ModelSetFailed],
  execute: ({ id, provider, modelId }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const model = yield* client.setModel(id, provider, modelId);
        return ModelSet({ model });
      }),
      (error) => ModelSetFailed({ message: error.message }),
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

/** Quick start: create the thread from the composer draft and set it to
 *  work (CONTEXT.md: Quick start). The first prompt provisions the env and
 *  starts the run; the pane watches it through the events. */
export const QuickStartCmd = Command.define("QuickStart", {
  args: { text: S.String },
  messages: [ThreadCreated, CreateFailed],
  execute: ({ text }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const created = yield* client.createThread(text, { autoName: true });
        yield* client.prompt(created.id, text);
        const thread = yield* client.getThread(created.id);
        return ThreadCreated({ thread });
      }),
      (error) => CreateFailed({ message: error.message }),
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
 * no-op message. The load path fires it with `force` — opening a thread
 * always lands at the end of the trail, never at the top of its history.
 *
 * The touch waits for the render commit: the command is forked before the
 * frame that carries its own update paints, so reading the trail in the
 * same tick would size the scroll against the previous frame.
 */
export const ScrollTrailCmd = Command.define("ScrollTrail", {
  args: { force: S.Boolean },
  messages: [ScrollDone],
  execute: ({ force }) =>
    Effect.gen(function* () {
      yield* Render.afterCommit;
      const el = document.getElementById("trail");
      if (el !== null) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
        if (force || nearBottom) el.scrollTop = el.scrollHeight;
      }
      return ScrollDone();
    }),
});
