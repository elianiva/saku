/**
 * The root's Model (root/model.ts): the current route plus the two submodel
 * slices it orchestrates and the connection domain. The root never reaches
 * into the child slices directly — it holds them, and every change flows
 * through the child's `update` via a `Got*Message` (or an
 * `informRouteChanged` hook). The `conn` state is the machine's state
 * (conn/machine.ts) and the `banner` is the one root-owned notice (wire
 * errors).
 */

import { Schema as S } from "effect";

import { Conn } from "../conn/machine.ts";
import * as Rail from "../rail/model.ts";
import { AppRoute } from "../route.ts";
import * as Thread from "../thread/model.ts";

export const Model = S.Struct({
  /** A dismissible top-level notice (wire errors); null when clean. */
  banner: S.NullOr(S.String),
  /** The wire connection lifecycle (conn/machine.ts). */
  conn: Conn,
  rail: Rail.Model,
  route: AppRoute,
  thread: Thread.Model,
});
export type Model = S.Schema.Type<typeof Model>;
