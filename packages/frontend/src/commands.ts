/**
 * Wire commands (commands.ts): every wire operation as a foldkit Command —
 * an Effect against the `Wire` service, landing back in the app as a
 * message (success or failure). Errors never escape as defects; they are
 * projected into `*Failed` messages so the banner can show them.
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
import { Wire } from "./wire.ts";

const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const candidate = error.message;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return String(error);
};

/** Connect (or reconnect) the wire client. */
export const WireConnectCmd = Command.define("WireConnect", {
  messages: [Connected, ConnectFailed],
  execute: Effect.gen(function* () {
    const { client } = yield* Wire;
    const hello = yield* client.connect();
    return Connected({ hello });
  }).pipe(Effect.catch((error) => Effect.succeed(ConnectFailed({ message: messageOf(error) })))),
});

/** List the registry (rail). */
export const ListThreadsCmd = Command.define("ListThreads", {
  messages: [ThreadsListed, ThreadsFailed],
  execute: Effect.gen(function* () {
    const { client } = yield* Wire;
    const threads = yield* client.listThreads();
    return ThreadsListed({ threads });
  }).pipe(Effect.catch((error) => Effect.succeed(ThreadsFailed({ message: messageOf(error) })))),
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
    }).pipe(Effect.catch((error) => Effect.succeed(CreateFailed({ message: messageOf(error) })))),
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
    }).pipe(Effect.catch((error) => Effect.succeed(DeleteFailed({ message: messageOf(error) })))),
});

/** Load a thread's entry trail (reads never start a session, ADR 0004). */
export const LoadTrailCmd = Command.define("LoadTrail", {
  args: { id: S.String },
  messages: [TrailLoaded, TrailFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const result = yield* client.getEntries(id, 0);
      return TrailLoaded({ id, entries: result.entries, tailSeq: result.tailSeq });
    }).pipe(Effect.catch((error) => Effect.succeed(TrailFailed({ message: messageOf(error) })))),
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
    }).pipe(Effect.catch((error) => Effect.succeed(SendFailed({ message: messageOf(error) })))),
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
    }).pipe(Effect.catch(() => Effect.succeed(AbortDone()))),
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
