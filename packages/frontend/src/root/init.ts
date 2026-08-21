/**
 * The root's cold-load `init` (root/init.ts): parses the boot URL into a
 * route, seeds the rail (idle — the list lands after the connect, which
 * would otherwise race the handshake) and the pane (route-derived), and
 * fires the boot Commands: connect the wire, plus the pane's trail read
 * when the boot URL pins a thread.
 */

import type { Url } from "foldkit";
import { Command } from "foldkit";

import { connMachine } from "../conn/machine.ts";
import { initialModel as initialRailModel } from "../rail/model.ts";
import { parseRoute } from "../route.ts";
import { initialModel as initialThreadModel } from "../thread/model.ts";
import { informRouteChanged } from "../thread/update.ts";
import type { Wire } from "../wire.ts";
import { WireConnectCmd } from "./command.ts";
import { GotThreadMessage } from "./message.ts";
import type { RootMessage } from "./message.ts";
import type { Model } from "./model.ts";

export type Commands = readonly Command.Command<RootMessage, never, Wire>[];
export type InitReturn = readonly [Model, Commands];

export const init = (url: Url.Url): InitReturn => {
  const route = parseRoute(url);
  // Not connected at boot: the pane's reads are suppressed here and issued
  // once by the Online transition — no handshake race, no double fetch.
  const [thread, threadCommands] = informRouteChanged(initialThreadModel(), route, false);
  return [
    {
      banner: null,
      conn: connMachine.initial,
      rail: initialRailModel(),
      route,
      thread,
    },
    [
      WireConnectCmd(),
      ...Command.mapMessages(threadCommands, (m) => GotThreadMessage({ message: m })),
    ],
  ];
};
