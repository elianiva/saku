/**
 * Wire commands (commands.ts): every wire operation as a foldkit Command —
 * an Effect against the `Wire` service, landing back in the app as a
 * message (success or failure). Errors never escape as defects; they are
 * projected into `*Failed` messages so the banner can show them. Every
 * command body fails only with `WireError`, so `catchTag` is precise.
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import {
  AbortDone,
  ConnectFailed,
  Connected,
  CreateFailed,
  DeleteFailed,
  PromptAcked,
  ScrollDone,
  SendFailed,
  ThreadCreated,
  ThreadDeleted,
  ThreadsFailed,
  ThreadsListed,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";
import { decodeEntry, type EntryProjection } from "./projection.ts";
import { Wire } from "./wire.ts";

/** Connect (or reconnect). The service re-resolves the bootstrap and swaps
 * the client when the daemon restarted on a new port (wire.ts). */
export const WireConnectCmd = Command.define("WireConnect", {
  messages: [Connected, ConnectFailed],
  execute: Effect.gen(function* () {
    const wire = yield* Wire;
    const hello = yield* wire.connect();
    return Connected({ hello });
  }).pipe(
    Effect.catchTag("WireError", (error) =>
      Effect.succeed(ConnectFailed({ message: error.message })),
    ),
  ),
});

/** List the registry (rail). */
export const ListThreadsCmd = Command.define("ListThreads", {
  messages: [ThreadsListed, ThreadsFailed],
  execute: Effect.gen(function* () {
    const { client } = yield* Wire;
    const threads = yield* client.listThreads();
    return ThreadsListed({ threads });
  }).pipe(
    Effect.catchTag("WireError", (error) =>
      Effect.succeed(ThreadsFailed({ message: error.message })),
    ),
  ),
});

/** Quick start: create the thread from the prompt and set it to work. */
export const QuickStartCmd = Command.define("QuickStart", {
  args: { text: S.String },
  messages: [ThreadCreated, CreateFailed],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const created = yield* client.createThread(text, { autoName: true });
      // The first prompt provisions the env and starts the run; the console
      // watches it through the events (CONTEXT.md: Quick start).
      yield* client.prompt(created.id, text);
      const thread = yield* client.getThread(created.id);
      return ThreadCreated({ thread });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(CreateFailed({ message: error.message })),
      ),
    ),
});

/** Delete a thread (registry record + worker storage). */
export const DeleteThreadCmd = Command.define("DeleteThread", {
  args: { id: S.String },
  messages: [ThreadDeleted, DeleteFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.deleteThread(id);
      return ThreadDeleted({ id });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(DeleteFailed({ message: error.message })),
      ),
    ),
});

/** Load a thread's entry trail (reads never start a session, ADR 0004). */
export const LoadTrailCmd = Command.define("LoadTrail", {
  args: { id: S.String },
  messages: [TrailLoaded, TrailFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const result = yield* client.getEntries(id, 0);
      const entries = result.entries
        .map(decodeEntry)
        .filter((entry): entry is EntryProjection => entry !== undefined);
      return TrailLoaded({ id, entries, tailSeq: result.tailSeq });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(TrailFailed({ message: error.message })),
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

/** Abort the in-flight run. */
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

/**
 * Scroll the trail to the bottom when the user is near it (they are
 * following the run). A message round-trip fires this; the command performs
 * the DOM touch and lands on a no-op message.
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
