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

import { WebSocket as WsWebSocket } from "ws";

interface ListenerEntry {
  readonly listener: (data: unknown) => void;
  readonly once: boolean;
}

/** The workerd `WebSocket` surface the adapter needs. */
export interface WorkerdWebSocketLike {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly addEventListener: (event: string, listener: (event: unknown) => void) => void;
  readonly removeEventListener: (event: string, listener: (event: unknown) => void) => void;
}

/** The listener surface every connection handler drives. */
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

/** The listener registry behind both adapters. */
const makeRegistry = () => {
  const listeners = new Map<string, Set<ListenerEntry>>();
  const on = (event: string, listener: (data: unknown) => void): void => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add({ listener, once: false });
  };
  const once = (event: string, listener: (data: unknown) => void): void => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add({ listener, once: true });
  };
  /** Remove one listener; true when the event has no listeners left. */
  const off = (event: string, listener: (data: unknown) => void): boolean => {
    const set = listeners.get(event);
    if (set === undefined) return true;
    for (const entry of [...set]) {
      if (entry.listener === listener) set.delete(entry);
    }
    if (set.size === 0) {
      listeners.delete(event);
      return true;
    }
    return false;
  };
  const dispatch = (event: string, data: unknown): void => {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      entry.listener(data);
    }
  };
  return { on, once, off, dispatch };
};

/** An event's payload: MessageEvent.data, ErrorEvent.error, else the event. */
const eventPayload = (ev: unknown): unknown => {
  if (ev === null || typeof ev !== "object") return ev;
  const record = ev as { data?: unknown; error?: unknown };
  if ("data" in record) return record.data;
  if ("error" in record && record.error !== undefined) return record.error;
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
  const handlers = new Map<string, (ev: unknown) => void>();
  const register = (event: string): void => {
    if (handlers.has(event)) return;
    const handler = (ev: unknown): void => registry.dispatch(event, eventPayload(ev));
    handlers.set(event, handler);
    ws.addEventListener(event, handler);
  };
  const unregister = (event: string): void => {
    const handler = handlers.get(event);
    if (handler === undefined) return;
    handlers.delete(event);
    ws.removeEventListener(event, handler);
  };
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: (event, listener) => {
      register(event);
      registry.on(event, listener);
    },
    once: (event, listener) => {
      register(event);
      registry.once(event, listener);
    },
    off: (event, listener) => {
      if (registry.off(event, listener)) unregister(event);
    },
    // DOs: workerd delivers accepted-socket messages through the DO's
    // webSocketMessage/webSocketClose methods — the DO forwards them here.
    receive: (data) => registry.dispatch("message", data),
    receiveClose: (code, reason) => registry.dispatch("close", { code, reason }),
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
  ws.on("open", () => registry.dispatch("open", undefined));
  ws.on("message", (data) => registry.dispatch("message", data));
  ws.on("error", (error) => registry.dispatch("error", error));
  ws.on("close", () => registry.dispatch("close", undefined));
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => {
      if (code === undefined) ws.close();
      else ws.close(code, reason);
    },
    on: (event, listener) => registry.on(event, listener),
    once: (event, listener) => registry.once(event, listener),
    off: (event, listener) => registry.off(event, listener),
  };
};

/** An outbound workerd socket factory for `RemoteEnv` (the DO's `socket` option). */
export const workerdSocketFactory = (url: string): SocketLike =>
  workerdSocket(new WebSocket(url) as unknown as WorkerdWebSocketLike);
