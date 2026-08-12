/**
 * Init (init.ts): the boot model — connecting, rail loading, nothing
 * selected — and the boot commands: connect the wire, then list the registry.
 */

import type { Command } from "foldkit";

import { WireConnectCmd } from "./commands.ts";
import type { AppMessage } from "./message.ts";
import { initialModel, type Model } from "./model.ts";
import { Wire } from "./wire.ts";

export type InitReturn = readonly [Model, ReadonlyArray<Command.Command<AppMessage, never, Wire>>];

// Connect first; the `Connected` transition lists the registry (a fresh
// connection needs a fresh list, and the boot list would race the handshake).
export const init = (): InitReturn => [initialModel, [WireConnectCmd()]];
