/**
 * The wire connection lifecycle (conn/machine.ts): one foldkit Machine
 * owning the connecting → online/offline transitions AND their commands —
 * a retry reconnects, a successful connect re-lists the registry (a fresh
 * connection needs a fresh list; the boot list would race the handshake).
 *
 * The machine is not a runtime: `conn` lives in the root Model and root
 * update steps it with every landed RootMessage. Messages with no edge from
 * the current state are ignored — that absence of an edge IS the behavior
 * (a retry tick while online does nothing; a closed socket while offline
 * keeps the current error). The editor-phase/offline-fill machine pattern
 * (lutra's phase.ts, offline/machine.ts).
 */

import { Schema as S } from "effect";
import { Machine } from "foldkit/experimental";
import { to } from "foldkit/experimental/machine";
import { ts } from "foldkit/schema";

import { RefreshRailCmd, WireConnectCmd } from "../root/command.ts";
import { RootMessage } from "../root/message.ts";

/** Dialing the wire (boot, or a retry tick while offline). */
export const Connecting = ts("Connecting");
/** The handshake answered; the top bar shows pid + version. */
export const Online = ts("Online", { pid: S.Number, version: S.String });
/** No live wire; the retry subscription keeps ticking. */
export const Offline = ts("Offline", { error: S.optional(S.String) });

export const Conn = S.Union([Connecting, Online, Offline]);
export type Conn = S.Schema.Type<typeof Conn>;

export const connMachine = Machine.define({ state: Conn, message: RootMessage })({
  initial: Connecting(),
  states: {
    Connecting: {
      on: {
        Connected: to(
          "Online",
          ({ message }) => Online({ pid: message.hello.pid, version: message.hello.version }),
          () => [RefreshRailCmd()],
        ),
        ConnectFailed: to("Offline", ({ message }) => Offline({ error: message.message })),
      },
    },
    Online: {
      on: {
        ConnectionClosed: to("Offline", () => Offline({ error: "connection closed" })),
      },
    },
    Offline: {
      on: {
        // The retry tick: back to dialing, the connect command rides along.
        RetryRequested: to(
          "Connecting",
          () => Connecting(),
          () => [WireConnectCmd()],
        ),
        // A reconnect succeeded: online again, and the registry re-lists.
        Connected: to(
          "Online",
          ({ message }) => Online({ pid: message.hello.pid, version: message.hello.version }),
          () => [RefreshRailCmd()],
        ),
        // A failed retry replaces the shown error (and keeps the retry loop
        // ticking — the state stayed Offline).
        ConnectFailed: to("Offline", ({ message }) => Offline({ error: message.message })),
        ConnectionClosed: to("Offline", () => Offline({ error: "connection closed" })),
      },
    },
  },
});
