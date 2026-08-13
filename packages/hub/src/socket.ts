/**
 * The socket surface (socket.ts): the small transport-agnostic shape the
 * hub's connection handlers drive — `on`/`once`/`off` listeners, `send`
 * for frames, `close` to drop.
 *
 * Node's `ws` sockets satisfy it directly (they are event-emitters with
 * exactly these methods); workerd `WebSocket`s (a Durable Object's
 * accepted sockets, or outbound sockets) are adapted with
 * `workerdSocket`. The wire server and the relay server are written
 * against this surface, so the same connection discipline runs on node
 * (the local spine, tests) and inside a DO (production, celld).
 */

/** The workerd `WebSocket` surface the adapter needs. */
export interface WorkerdWebSocketLike {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly addEventListener: (event: string, listener: (event: unknown) => void) => void;
  readonly removeEventListener: (event: string, listener: (event: unknown) => void) => void;
}

/** The listener surface the hub's handlers use. */
export interface SocketLike {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly on: (event: string, listener: (data: unknown) => void) => void;
  readonly once: (event: string, listener: (data: unknown) => void) => void;
  readonly off: (event: string, listener: (data: unknown) => void) => void;
  /**
   * Push an inbound message into the socket (DOs only: workerd delivers
   * accepted-socket messages through the DO's `webSocketMessage`, so the
   * DO forwards them here).
   */
  readonly receive?: (data: unknown) => void;
  /** Push an inbound close into the socket (DOs: `webSocketClose`). */
  readonly receiveClose?: (code: number, reason: string) => void;
}

interface ListenerEntry {
  readonly listener: (data: unknown) => void;
  readonly once: boolean;
}

/** Adapt a workerd `WebSocket` to the hub's `SocketLike` surface. */
export const workerdSocket = (ws: WorkerdWebSocketLike): SocketLike => {
  const listeners = new Map<string, Set<ListenerEntry>>();
  const dispatch =
    (event: string) =>
    (ev: unknown): void => {
      const set = listeners.get(event);
      if (set === undefined) return;
      const data =
        ev !== null && typeof ev === "object" && "data" in (ev as { data?: unknown })
          ? (ev as { data?: unknown }).data
          : ev;
      for (const entry of [...set]) {
        if (entry.once) set.delete(entry);
        entry.listener(data);
      }
    };
  const handlers = new Map<string, (ev: unknown) => void>();
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: (event, listener) => {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
        const handler = dispatch(event);
        handlers.set(event, handler);
        ws.addEventListener(event, handler);
      }
      set.add({ listener, once: false });
    },
    once: (event, listener) => {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
        const handler = dispatch(event);
        handlers.set(event, handler);
        ws.addEventListener(event, handler);
      }
      set.add({ listener, once: true });
    },
    off: (event, listener) => {
      const set = listeners.get(event);
      if (set === undefined) return;
      for (const entry of [...set]) {
        if (entry.listener === listener) set.delete(entry);
      }
      if (set.size === 0) {
        listeners.delete(event);
        const handler = handlers.get(event);
        if (handler !== undefined) ws.removeEventListener(event, handler);
        handlers.delete(event);
      }
    },
    // DOs: workerd delivers accepted-socket messages through the DO's
    // webSocketMessage/webSocketClose methods — the DO forwards them here.
    receive: (data) => {
      const set = listeners.get("message");
      if (set === undefined) return;
      for (const entry of [...set]) entry.listener(data);
    },
    receiveClose: (code, reason) => {
      const set = listeners.get("close");
      if (set === undefined) return;
      for (const entry of [...set]) {
        if (entry.once) set.delete(entry);
        entry.listener({ code, reason });
      }
    },
  };
};
