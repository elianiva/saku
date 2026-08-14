/**
 * The rail submodel's commands (rail/command.ts): the registry operations as
 * foldkit Commands landing rail messages. Errors never escape as defects —
 * every command body fails only with `WireError`, and the shared
 * `catchWireError` (root/command.ts) projects it into a `*Failed` message so
 * the rail can show it. The quick-start command moved to the pane with the
 * gesture (thread/command.ts).
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import { catchWireError } from "../root/command.ts";
import { Wire } from "../wire.ts";
import { DeleteFailed, ListFailed, ThreadDeleted, ThreadsListed } from "./message.ts";

/** List the registry (the rail's grid). */
export const ListThreadsCmd = Command.define("ListThreads", {
  messages: [ThreadsListed, ListFailed],
  execute: catchWireError(
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const threads = yield* client.listThreads();
      return ThreadsListed({ threads });
    }),
    (error) => ListFailed({ error }),
  ),
});

/** Delete a thread (registry record + worker storage). */
export const DeleteThreadCmd = Command.define("DeleteThread", {
  args: { id: S.String },
  messages: [ThreadDeleted, DeleteFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        yield* client.deleteThread(id);
        return ThreadDeleted({ id });
      }),
      (error) => DeleteFailed({ error }),
    ),
});
