/**
 * The connection domain's messages (conn/message.ts): the wire handshake
 * outcomes plus the retry tick. Root-owned — the conn machine (machine.ts)
 * steps on them, and the top bar renders the state. Re-exported into
 * RootMessage so the runtime delivers them straight to the root's update.
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { HelloOk } from "@saku/wire";

/** The handshake succeeded (`WireConnectCmd`'s success landing). */
export const Connected = Message.m("Connected", { hello: HelloOk });
/** The handshake failed; the machine shows the offline state. */
export const ConnectFailed = Message.m("ConnectFailed", { message: S.String });
/** The socket closed after a successful handshake. */
export const ConnectionClosed = Message.m("ConnectionClosed");
/** The retry subscription's tick while offline (subscriptions.ts). */
export const RetryRequested = Message.m("RetryRequested");
