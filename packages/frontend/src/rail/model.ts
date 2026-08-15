/**
 * The rail submodel's Model (rail/model.ts): the registry list as AsyncData
 * (Idle → Success/Failure), the route-derived selection highlight, and a
 * transient notice for delete failures. Row content comes entirely from
 * `thread_changed` broadcasts and command landings; the rail never computes
 * thread state. The pi-session list (CONTEXT.md: Pi sessions) rides the
 * same shape — loaded on connect alongside the registry, filtered against
 * adopted threads at render (presentation.ts), with `adopting` guarding
 * double adoptions. The quick-start gesture lives on the pane's welcome
 * now — this file is the list and nothing else.
 */

import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { PiSessionInfo, ThreadInfo, WireError } from "@saku/wire";

/** The registry list `listThreads()` returns, held as AsyncData. */
export const ThreadList = AsyncData.Schema(S.Array(ThreadInfo), WireError);
export const threadList = ThreadList;

/** The pi session list `listPiSessions()` returns, held as AsyncData. */
export const PiSessions = AsyncData.Schema(S.Array(PiSessionInfo), WireError);
export const piSessions = PiSessions;

export const Model = S.Struct({
  list: ThreadList.schema,
  /** The route's pinned thread (the row highlight); null on the root route. */
  selectedId: S.NullOr(S.String),
  /** A transient banner message (e.g. a failed delete); null when clean. */
  notice: S.NullOr(S.String),
  /** Pi's sessions on this machine (the local daemon serves these). */
  piSessions: PiSessions.schema,
  /** A pi adoption is in flight (guards double adoptions); null when clean. */
  adopting: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = () => ({
  list: ThreadList.Idle(),
  selectedId: null,
  notice: null,
  piSessions: PiSessions.Idle(),
  adopting: null,
});
