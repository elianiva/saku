/**
 * RemoteEnv reconnection (remote-reconnect.test.ts): the connection is the
 * module's implementation detail — a dropped socket heals on the next op,
 * and `connect()` is idempotent while connected. Driven entirely by a
 * scripted daemon whose sockets accept on a microtask (the client attaches
 * its listeners synchronously after the factory returns).
 */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "@saku/wire";
import { parseFrame, serializeFrame } from "@saku/wire";

import { RemoteEnv } from "../src/remote.ts";
import type { SocketEventPayload, SocketLike } from "../src/socket.ts";

/** Whether a parsed frame is a JSON object carrying a `_tag` (the op check). */
const isTaggedFrame = (value: JsonValue | undefined): value is { readonly _tag?: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One scripted daemon connection (see `scriptedConnection`). */
interface ScriptedConnection {
  /** The daemon accepted the TCP connection (the client's `open` event). */
  readonly accept: () => void;
  /** The daemon dropped the socket (a restart, a relay teardown). */
  readonly drop: () => void;
  readonly socket: SocketLike;
}

/**
 * One scripted daemon-side connection: answers `env_hello` and
 * `read_text_file`; `close` simulates the daemon dropping it.
 */
const scriptedConnection = (): ScriptedConnection => {
  const listeners = new Map<string, Set<(data: SocketEventPayload) => void>>();
  const fire = (event: string, data: SocketEventPayload) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(data);
    }
  };
  const reply = (frame: JsonValue) => {
    socket.receive?.(serializeFrame(frame));
  };
  const socket: SocketLike = {
    close: () => {
      fire("close", undefined);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    once: (event, listener) => {
      const wrap = (data: SocketEventPayload) => {
        socket.off(event, wrap);
        listener(data);
      };
      socket.on(event, wrap);
    },
    receive: (data) => {
      fire("message", data);
    },
    send: (line) => {
      const frame = parseFrame(line);
      if (!isTaggedFrame(frame)) {
        return;
      }
      if (frame._tag === "env_hello") {
        reply({ _tag: "env_hello_ok", cwd: "/work", pid: 1, version: "test" });
        return;
      }
      const op = frame._tag === "env_request" ? frame.op : undefined;
      if (typeof frame.id === "string" && isTaggedFrame(op) && op._tag === "read_text_file") {
        reply({ _tag: "env_response", id: frame.id, ok: true, payload: "contents" });
      }
    },
  };
  return {
    /** The daemon accepted the TCP connection (the client's `open` event). */
    accept: () => queueMicrotask(() => fire("open", undefined)),
    /** The daemon dropped the socket (a restart, a relay teardown). */
    drop: () => socket.close(),
    socket,
  };
};

describe("RemoteEnv reconnection", () => {
  it("heals a dropped connection on the next op, without caller intervention", async () => {
    const served: ScriptedConnection[] = [];
    const env = new RemoteEnv({
      cwd: "/work",
      socket: () => {
        const connection = scriptedConnection();
        served.push(connection);
        connection.accept();
        return connection.socket;
      },
      token: "t",
      url: "ws://env.test",
    });

    const hello = await env.connect();
    expect(hello.cwd).toBe("/work");

    // Idempotent while connected: no second dial.
    await env.connect();
    expect(served).toHaveLength(1);

    const firstRead = await env.readTextFile("/x");
    expect(firstRead).toEqual({ ok: true, value: "contents" });

    // The daemon drops the socket (a restart); the next op reconnects.
    served[0]?.drop();

    const healed = await env.readTextFile("/x");
    expect(healed).toEqual({ ok: true, value: "contents" });
    expect(served).toHaveLength(2);
  });
});
