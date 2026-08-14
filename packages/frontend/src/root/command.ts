/**
 * The root's commands (root/command.ts): the connect command (conn domain),
 * the navigation command (the root owns URLs), the refresh-the-rail command
 * the conn machine fires on a successful connect — and the shared
 * `catchWireError` helper every command module uses (house pattern: every
 * command body fails only with `WireError`, errors never escape as
 * defects; the helper projects them into a `*Failed` message).
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { WireError } from "@saku/wire";

import { Connected, ConnectFailed } from "../conn/message.ts";
import { RefreshRequested } from "../rail/message.ts";
import { Wire } from "../wire.ts";
import { GotRailMessage, NavigatedTo } from "./message.ts";

/** Map a WireError into a `*Failed` message (the one failure channel). */
export const catchWireError = <A, R, M>(
  effect: Effect.Effect<A, WireError, R>,
  failed: (error: WireError) => M,
): Effect.Effect<A | M, never, R> =>
  effect.pipe(Effect.catchTag("WireError", (error) => Effect.succeed(failed(error))));

/** Connect (or reconnect). The service re-resolves the bootstrap and swaps
 *  the client when the daemon restarted on a new port (wire.ts). */
export const WireConnectCmd = Command.define("WireConnect", {
  messages: [Connected, ConnectFailed],
  execute: catchWireError(
    Effect.gen(function* () {
      const wire = yield* Wire;
      const hello = yield* wire.connect();
      return Connected({ hello });
    }),
    (error) => ConnectFailed({ message: error.message }),
  ),
});

/** The conn machine's Connected edge: a fresh connection needs a fresh list
 *  (the boot list would race the handshake). Lands a wrapped rail message so
 *  the rail's own update runs the list command. */
export const RefreshRailCmd = Command.define("RefreshRail", {
  messages: [GotRailMessage],
  execute: Effect.sync(() => GotRailMessage({ message: RefreshRequested() })),
});

/** Push a URL; the navigation layer reports the change back as ChangedRoute,
 *  which drives the route-derived submodel state (ADR 0009). */
export const NavigateToCmd = Command.define("NavigateTo", {
  args: { path: S.String },
  messages: [NavigatedTo],
  execute: ({ path }) => pushUrl(path).pipe(Effect.as(NavigatedTo())),
});
