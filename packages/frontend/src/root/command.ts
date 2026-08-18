/**
 * The root's commands (root/command.ts): the connect command (conn domain),
 * the navigation command (the root owns URLs), the refresh-the-rail command
 * the conn machine fires on a successful connect. (House pattern: every
 * command body fails only with `WireError`, errors never escape as
 * defects; each body catches the tag and projects it into a `*Failed`
 * message.)
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { Connected, ConnectFailed } from "../conn/message.ts";
import { RefreshRequested } from "../rail/message.ts";
import { Wire } from "../wire.ts";
import { GotRailMessage, NavigatedTo } from "./message.ts";

/** Connect (or reconnect). The service re-resolves the bootstrap and swaps
 *  the client when the daemon restarted on a new port (wire.ts). */
export const WireConnectCmd = Command.define("WireConnect", {
  execute: Effect.gen(function* () {
    const wire = yield* Wire;
    const hello = yield* wire.connect();
    return Connected({ hello });
  }).pipe(
    Effect.catchTag("WireError", (failure) =>
      Effect.succeed(ConnectFailed({ message: failure.message })),
    ),
  ),
  messages: [Connected, ConnectFailed],
});

/** The conn machine's Connected edge: a fresh connection needs a fresh list
 *  (the boot list would race the handshake). Lands a wrapped rail message so
 *  the rail's own update runs the list command. */
export const RefreshRailCmd = Command.define("RefreshRail", {
  execute: Effect.sync(() => GotRailMessage({ message: RefreshRequested() })),
  messages: [GotRailMessage],
});

/** Push a URL; the navigation layer reports the change back as ChangedRoute,
 *  which drives the route-derived submodel state (the informing convention). */
export const NavigateToCmd = Command.define("NavigateTo", {
  args: { path: S.String },
  execute: ({ path }) => pushUrl(path).pipe(Effect.as(NavigatedTo())),
  messages: [NavigatedTo],
});
