/**
 * The thread submodel's Model (thread/model.ts): the active thread's id
 * (route-derived), its registry info, the entry trail (AsyncData), the live
 * run, and the composer. The id and info are the pane's identity — set by
 * the route (`informRouteChanged`) and kept current by the registry
 * broadcasts the root delegates down (ThreadChanged). The trail and the
 * live region are the wire-derived view owned by the pure fold (live.ts);
 * this file only composes them into the model.
 *
 * The composer draft is shared between the welcome (quick start on the root
 * route) and the thread prompt — it is user draft, not thread state. The
 * `starting` flag guards against double quick-starts while the create is in
 * flight, and `focused` drives the focus-aware placeholder.
 */

import { Schema as S } from "effect";
import { ThreadInfo } from "@saku/wire";

import { emptyLiveRegion, LiveRegion, Trail } from "./live.ts";

export const Model = S.Struct({
  /** The active thread id; null renders the pane's welcome. */
  id: S.NullOr(S.String),
  /** The registry's word about this thread (name, mode, state, env). */
  info: S.NullOr(ThreadInfo),
  /** The entry trail: idle → success/failure (live.ts). */
  trail: Trail.schema,
  /** The run in flight (live.ts). */
  live: LiveRegion,
  /** The composer's text — shared between the welcome and the thread. */
  composer: S.String,
  /** A quick start is in flight (guards Enter against double creates). */
  starting: S.Boolean,
  /** The composer's focus state, for the focus-aware placeholder. */
  focused: S.Boolean,
  /** A transient failure notice (create/send failures); null when clean. */
  notice: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = (): Model => ({
  id: null,
  info: null,
  trail: Trail.Idle(),
  live: emptyLiveRegion(),
  composer: "",
  starting: false,
  focused: false,
  notice: null,
});
