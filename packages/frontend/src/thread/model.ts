/**
 * The thread submodel's Model (thread/model.ts): the active thread's id
 * (route-derived), its registry info, the entry trail (AsyncData), the live
 * run, and the composer. The id and info are the pane's identity — set by
 * the route (`informRouteChanged`) and kept current by the registry
 * broadcasts the root delegates down (ThreadChanged). The trail and the
 * live region are the wire-derived view owned by the pure fold (live.ts);
 * this file only composes them into the model.
 */

import { Schema as S } from "effect";
import { ThreadInfo } from "@saku/wire";

import { emptyLiveRegion, LiveRegion, Trail } from "./live.ts";

export const Model = S.Struct({
  /** The active thread id; null renders the pane's empty state. */
  id: S.NullOr(S.String),
  /** The registry's word about this thread (name, mode, state, env). */
  info: S.NullOr(ThreadInfo),
  /** The entry trail: idle → success/failure (live.ts). */
  trail: Trail.schema,
  /** The run in flight (live.ts). */
  live: LiveRegion,
  /** The thread composer's text. */
  composer: S.String,
  /** A transient failure notice (send failures); null when clean. */
  notice: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = (): Model => ({
  id: null,
  info: null,
  trail: Trail.Idle(),
  live: emptyLiveRegion(),
  composer: "",
  notice: null,
});
