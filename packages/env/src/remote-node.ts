/**
 * The node socket factory for `RemoteEnv` (remote-node.ts): the `ws`
 * package's `WebSocket` adapted to the `SocketLike` surface. Node-only —
 * DOs and celld use `workerdSocket` from remote.ts instead.
 */

import { WebSocket } from "ws";
import type { SocketLike } from "./remote.ts";

/** A `ws` socket shaped as the `SocketLike` RemoteEnv drives. */
export const nodeSocket = (url: string): SocketLike => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, listener) => {
      if (event === "open") {
        ws.on("open", () => listener(undefined));
      } else if (event === "message") {
        ws.on("message", (data) => listener(data));
      } else if (event === "error") {
        ws.on("error", (error) => listener(error));
      } else {
        ws.on("close", () => listener(undefined));
      }
    },
  };
};
