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
import { AsyncData } from "foldkit";
import { ThreadInfo, WireError, WireModelInfo } from "@saku/wire";

import { emptyLiveRegion, LiveRegion, Trail } from "./live.ts";

/** The switchable models `getAvailableModels()` returns, held as AsyncData. */
export const ModelPicker = AsyncData.Schema(S.Array(WireModelInfo), WireError);

/** The transient Lexical trigger shown in Foldkit's suggestion panel. The
 * editor remains the source of truth for text and selection; this only holds
 * the small amount of view state needed to render and navigate suggestions. */
export const ComposerMenu = S.Struct({
  trigger: S.Literals(["file", "command"]),
  query: S.String,
  active: S.Number,
});

export const Model = S.Struct({
  /** The active thread id; null renders the pane's welcome. */
  id: S.NullOr(S.String),
  /** The registry's word about this thread (name, mode, state, env). */
  info: S.NullOr(ThreadInfo),
  /** The entry trail: idle → success/failure (live.ts). */
  trail: Trail.schema,
  /** The run in flight (live.ts). */
  live: LiveRegion,
  /** Trail entry ids whose thinking block is expanded (default: collapsed;
   *  the live region streams open regardless, view.ts). */
  thinkingOpen: S.Array(S.String),
  /** Trail entry/tool-call ids whose tool rows are expanded (default:
   *  collapsed, view.ts). */
  toolsOpen: S.Array(S.String),
  /** The pinned thread's current model (`get_state`, read-only); null on the
   *  welcome and before the state read lands. */
  model: S.NullOr(WireModelInfo),
  /** The composer's model picker: Idle = closed. */
  modelPicker: ModelPicker.schema,
  /** The floating usage panel (the context badge's breakdown); false =
   *  closed. */
  usageOpen: S.Boolean,
  /** The picker's search filter ("" = all models). */
  pickerQuery: S.String,
  /** The highlighted option's index into the filtered list; -1 when empty. */
  pickerActive: S.Number,
  /** A model switch is in flight (guards double picks). */
  modelBusy: S.Boolean,
  /** The composer's text — shared between the welcome and the thread. */
  composer: S.String,
  /** The Foldkit-owned palette for the Lexical editor's @ and / triggers. */
  composerMenu: S.NullOr(ComposerMenu),
  /** A quick start is in flight (guards Enter against double creates). */
  starting: S.Boolean,
  /** The composer's focus state, for the focus-aware placeholder. */
  focused: S.Boolean,
  /** A transient failure notice (create/send failures); null when clean. */
  notice: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = () => ({
  id: null,
  info: null,
  trail: Trail.Idle(),
  live: emptyLiveRegion(),
  thinkingOpen: [],
  toolsOpen: [],
  model: null,
  modelPicker: ModelPicker.Idle(),
  usageOpen: false,
  pickerQuery: "",
  pickerActive: 0,
  modelBusy: false,
  composer: "",
  composerMenu: null,
  starting: false,
  focused: false,
  notice: null,
});
