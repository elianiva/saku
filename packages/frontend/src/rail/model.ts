/**
 * The rail submodel's Model (rail/model.ts): the registry list as AsyncData
 * (Idle → Success/Failure), the route-derived selection highlight, the
 * quick-start composer's text, and a transient notice for create/delete
 * failures. Row content comes entirely from `thread_changed` broadcasts and
 * command landings; the rail never computes thread state.
 */

import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { ThreadInfo, WireError } from "@saku/wire";

/** The registry list `listThreads()` returns, held as AsyncData. */
export const ThreadList = AsyncData.Schema(S.Array(ThreadInfo), WireError);
export const threadList = ThreadList;

export const Model = S.Struct({
  list: ThreadList.schema,
  /** The route's pinned thread (the row highlight); null on the root route. */
  selectedId: S.NullOr(S.String),
  /** The quick-start composer's text (rail). */
  input: S.String,
  /** A transient banner message (e.g. a failed create); null when clean. */
  notice: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = (): Model => ({
  list: ThreadList.Idle(),
  selectedId: null,
  input: "",
  notice: null,
});
