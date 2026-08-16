/**
 * The socket surface (socket.ts): ONE transport-agnostic WebSocket shape
 * for every connection the spine drives — the env daemon's transports,
 * the hub's wire and relay cores, and the worker's `RemoteEnv`.
 *
 * `SocketLike` is the listener surface: `on`/`once`/`off` for the
 * message/close/error events (plus `open`, for outbound connections),
 * `send` for frames, `close` to drop. Two adapters satisfy it:
 *
 * - `workerdSocket` — a workerd `WebSocket`, serving both delivery
 *   models of the platform: outbound sockets fire their events through
 *   `addEventListener`, while a Durable Object's accepted sockets
 *   deliver messages through the DO's `webSocketMessage`/`webSocketClose`
 *   methods (not event listeners) — the DO forwards them into the
 *   socket with `receive`/`receiveClose`. Both paths dispatch the same
 *   listener registry, so one socket object serves inbound and outbound
 *   connections alike.
 * - `nodeSocket` — the `ws` package's `WebSocket` (node: the local
 *   spine, the CLI, tests), whose native events feed the same registry
 *   shape.
 *
 * `workerdSocketFactory` is the outbound factory `RemoteEnv` uses in a
 * DO (thread-do), matching `nodeSocket` on node — the env protocol is
 * the same over both.
 */

import type { RawData } from "ws";
import { WebSocket as WsWebSocket } from "ws";
import type { SocketMessage } from "@saku/wire";

/** A platform socket event's close payload: workerd's CloseEvent code/reason. */
interface ClosePayload {
  readonly code?: number | undefined;
  readonly reason?: string | undefined;
}

/** A payload the registry can deliver to a listener: message data, an error, a close, or nothing. */
type SocketEventPayload = SocketMessage | Error | ClosePayload | undefined;

/** A platform socket event, structurally (the fields the adapter reads). */
export interface SocketEvent {
  readonly code?: number;
  readonly data?: SocketMessage;
  readonly error?: Error;
  readonly reason?: string;
}

/** Whether a node `ws` payload is a binary socket message (ws delivers Buffers; never Buffer[] for whole frames). */
const isSocketMessageData = (data: RawData): data is ArrayBuffer | Buffer =>
  data instanceof ArrayBuffer || ArrayBuffer.isView(data);

/** A registered listener: the registry delivers raw payloads through it. */
interface ListenerEntry {
  readonly listener: (data: SocketEventPayload) => void;
  readonly once: boolean;
}

/** The workerd `WebSocket` surface the adapter needs. */
export interface WorkerdWebSocketLike {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly addEventListener: (event: string, listener: (event: SocketEvent) => void) => void;
  readonly removeEventListener: (event: string, listener: (event: SocketEvent) => void) => void;
}

/** The listener surface every connection handler drives. */
export interface SocketLike {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly on: (event: string, listener: (data: SocketEventPayload) => void) => void;
  readonly once: (event: string, listener: (data: SocketEventPayload) => void) => void;
  readonly off: (event: string, listener: (data: SocketEventPayload) => void) => void;
  /**
   * Push an inbound message into the socket (DOs only: workerd delivers
   * accepted-socket messages through the DO's `webSocketMessage`, so the
   * DO forwards them here).
   */
  readonly receive?: (data: SocketMessage) => void;
  /** Push an inbound close into the socket (DOs: `webSocketClose`). */
  readonly receiveClose?: (code: number, reason: string) => void;
}

/** The listener registry behind both adapters. */
const makeRegistry = () => {
  const listeners = new Map<string, Set<ListenerEntry>>();
  const on = (event: string, listener: (data: SocketEventPayload) => void) => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add({ listener, once: false });
  };
  const once = (event: string, listener: (data: SocketEventPayload) => void) => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add({ listener, once: true });
  };
  /** Remove one listener; true when the event has no listeners left. */
  const off = (event: string, listener: (data: SocketMessage) => void) => {
    const set = listeners.get(event);
    if (set === undefined) {
      return true;
    }
    for (const entry of set) {
      if (entry.listener === listener) {
        set.delete(entry);
      }
    }
    if (set.size === 0) {
      listeners.delete(event);
      return true;
    }
    return false;
  };
  const dispatch = (event: string, data?: SocketEventPayload) => {
    const set = listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const entry of set) {
      if (entry.once) {
        set.delete(entry);
      }
      entry.listener(data);
    }
  };
  return { dispatch, off, on, once };
};

/** A close event's payload (workerd's CloseEvent code/reason, when present). */
const closePayloadOf = (code: number | undefined, reason: string | undefined): ClosePayload => {
  if (code === undefined && reason === undefined) {
    return {};
  }
  if (code === undefined) {
    return { reason };
  }
  if (reason === undefined) {
    return { code };
  }
  return { code, reason };
};

/** An event's payload: MessageEvent.data, ErrorEvent.error, a close's code/reason, else the event. */
const eventPayload = (ev: SocketEvent): SocketEventPayload => {
  if ("data" in ev) {
    return ev.data;
  }
  if ("error" in ev && ev.error !== undefined) {
    return ev.error;
  }
  if ("code" in ev || "reason" in ev) {
    return closePayloadOf(ev.code, ev.reason);
  }
  return ev;
};

/**
 * Adapt a workerd `WebSocket` to the `SocketLike` surface (DOs, celld).
 * A single listener registry is fed from both of the platform's delivery
 * models: `addEventListener` registration (outbound sockets, and any
 * platform that fires events) and the `receive`/`receiveClose` hooks
 * (a DO's accepted sockets, whose messages arrive through
 * `webSocketMessage`/`webSocketClose`).
 */
export const workerdSocket = (ws: WorkerdWebSocketLike): SocketLike => {
  const registry = makeRegistry();
  const handlers = new Map<string, (ev: SocketEvent) => void>();
  const register = (event: string) => {
    if (handlers.has(event)) {
      return;
    }
    const handler = (ev: SocketEvent) => {
      registry.dispatch(event, eventPayload(ev));
    };
    handlers.set(event, handler);
    ws.addEventListener(event, handler);
  };
  const unregister = (event: string) => {
    const handler = handlers.get(event);
    if (handler === undefined) {
      return;
    }
    handlers.delete(event);
    ws.removeEventListener(event, handler);
  };
  return {
    close: (code, reason) => {
      ws.close(code, reason);
    },
    off: (event, listener) => {
      if (registry.off(event, listener)) {
        unregister(event);
      }
    },
    on: (event, listener) => {
      register(event);
      registry.on(event, listener);
    },
    once: (event, listener) => {
      register(event);
      registry.once(event, listener);
    },
    // DOs: workerd delivers accepted-socket messages through the DO's
    // webSocketMessage/webSocketClose methods — the DO forwards them here.
    receive: (data) => {
      registry.dispatch("message", data);
    },
    receiveClose: (code, reason) => {
      registry.dispatch("close", { code, reason });
    },
    send: (data) => {
      ws.send(data);
    },
  };
};

/**
 * A node `ws` socket shaped as the `SocketLike` surface. The node events
 * are normalized to the socket payloads: message data as-is, errors as
 * the `Error`, open/close as `undefined`.
 */
export const nodeSocket = (url: string): SocketLike => {
  const ws = new WsWebSocket(url);
  const registry = makeRegistry();
  ws.on("open", () => {
    registry.dispatch("open");
  });
  ws.on("message", (data) => {
    if (isSocketMessageData(data)) {
      registry.dispatch("message", data);
    }
  });
  ws.on("error", (error) => {
    registry.dispatch("error", error);
  });
  ws.on("close", () => {
    registry.dispatch("close");
  });
  return {
    close: (code, reason) => {
      if (code === undefined) {
        ws.close();
      } else {
        ws.close(code, reason);
      }
    },
    off: (event, listener) => {
      registry.off(event, listener);
    },
    on: (event, listener) => {
      registry.on(event, listener);
    },
    once: (event, listener) => {
      registry.once(event, listener);
    },
    send: (data) => {
      ws.send(data);
    },
  };
};

/** An outbound workerd socket factory for `RemoteEnv` (the DO's `socket` option). */
export const workerdSocketFactory = (url: string): SocketLike => workerdSocket(new WebSocket(url));
