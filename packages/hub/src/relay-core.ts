/**
 * The hub's relay server (relay.ts): how the user's machine — which has
 * no open ports — becomes reachable (ADR 0003).
 *
 * The env daemon dials the hub and registers with `relay_hello {envId,
 * token}`; a worker-side `RemoteEnv` attaches with `relay_attach {envId,
 * token}`; the hub pipes everything after those frames between the two
 * sockets — the env protocol flows through unchanged, and the hub never
 * interprets it. The daemon's socket and the worker's socket are peers:
 * either side dropping closes the pipe.
 *
 * Auth is the deployment secret (v1: single-owner shared secret), the
 * same credential the wire's `hello` uses. The connection logic lives in
 * `HubRelayCore.make` against the `SocketLike` surface — the node server
 * (`HubRelay.make`) feeds it `ws` sockets; the alchemy DO adapter (M4)
 * feeds it a Durable Object's accepted sockets, multiplexing the relay
 * behind the same domain as the wire server.
 */

import { Context, Effect, Ref, Result, Schema } from "effect";

import { decodeFrame, isSocketMessage, parseFrame, serializeFrame } from "@saku/wire";
import { ENV_VERSION, EnvErrorFrame, RelayAttach, RelayHello } from "@saku/env";

import type { SocketLike } from "./socket.ts";

/** The payload a socket listener receives (message data, an error, a close payload, or nothing). */
type SocketPayload = Parameters<Parameters<SocketLike["on"]>[1]>[0];

export interface RelayServerOptions {
  /** The deployment secret both sides present in their first frame. */
  readonly token: string;
  readonly log?: (message: string) => Effect.Effect<void>;
}

export interface HubRelayApi {
  /** The ws:// URL env daemons and RemoteEnvs connect to. */
  readonly url: string;
  /** The envIds currently registered. */
  readonly registered: () => Effect.Effect<readonly string[]>;
  /** Stop the relay: drop all sockets, close the server. */
  readonly close: () => Effect.Effect<void>;
}

/** The relay's first frame is any JSON object; only `_tag` discriminates it here. */
const isFrameObject = (value: ReturnType<typeof parseFrame>): value is { readonly _tag?: string } =>
  typeof value === "object" && value !== null;

/** Send an error frame best-effort, then drop the socket. */
const failSocket = (socket: SocketLike, message: string) => {
  Result.try(() => {
    socket.send(serializeFrame(EnvErrorFrame.make({ message })));
  });
  socket.close();
};

/** Pipe one socket's frames onto the other; both die together. Frames are
 * normalized to text at the pipe (ws delivers text as Buffers) — the env
 * protocol is text, and the daemon's decoder is the contract. */
const pipeSockets = (from: SocketLike, to: SocketLike, cleanup: () => void) => {
  const onMessage = (data: SocketPayload) => {
    if (!isSocketMessage(data)) {
      return;
    }
    const text = Result.try(() => decodeFrame(data));
    if (Result.isFailure(text)) {
      return;
    }
    // A dead peer between the check and the send is a no-op; the close
    // handler tears both sides down.
    Result.try(() => {
      to.send(text.success);
    });
  };
  const onClose = () => {
    cleanup();
    Result.try(() => {
      to.close();
    });
  };
  from.on("message", onMessage);
  from.once("close", onClose);
  return () => {
    from.off("message", onMessage);
    from.off("close", onClose);
  };
};

export interface HubRelayCoreApi {
  /** Handle one accepted socket (the first frame decides its role). */
  readonly handleConnection: (socket: SocketLike) => void;
  /** The envIds currently registered. */
  readonly registered: () => Effect.Effect<readonly string[]>;
  /** Drop every socket (registrations, waiting workers, buffers). */
  readonly close: () => Effect.Effect<void>;
}

/** The hub's relay connection logic, transport-free (node ws or DO sockets). */
export class HubRelayCore extends Context.Service<HubRelayCore, HubRelayCoreApi>()("HubRelayCore", {
  make: Effect.fn("HubRelayCore.make")(function* (options: RelayServerOptions) {
    const log = options.log ?? (() => Effect.void);
    const envsRef = yield* Ref.make<Map<string, SocketLike>>(new Map());
    const waitingRef = yield* Ref.make<Map<string, Set<SocketLike>>>(new Map());
    const closedRef = yield* Ref.make(false);

    /** Remove the env's registration (its socket closed). */
    const unregister = (envId: string, socket: SocketLike) => {
      void Effect.runFork(
        Ref.update(envsRef, (envs) => {
          if (envs.get(envId) !== socket) {
            return envs;
          }
          const next = new Map(envs);
          next.delete(envId);
          return next;
        }),
      );
    };

    // Frames a worker sends while waiting for its env's daemon to register.
    const buffers = new Map<SocketLike, string[]>();

    const detachFromWorker = (envId: string, socket: SocketLike) => {
      void Effect.runFork(
        Ref.update(waitingRef, (waiting) => {
          const set = waiting.get(envId);
          if (set === undefined || !set.has(socket)) {
            return waiting;
          }
          const next = new Set(set);
          next.delete(socket);
          return new Map(waiting).set(envId, next);
        }),
      );
    };

    /** Pipe worker ⇄ daemon; either side dropping closes the other. */
    const pipeBoth = (envId: string, worker: SocketLike, daemon: SocketLike) => {
      // Flush anything the worker sent while it was waiting for this daemon.
      const buffered = buffers.get(worker);
      if (buffered !== undefined) {
        buffers.delete(worker);
        for (const frame of buffered) {
          Result.try(() => {
            daemon.send(frame);
          });
        }
      }
      pipeSockets(worker, daemon, () => {
        Result.try(() => {
          daemon.close();
        });
        detachFromWorker(envId, worker);
      });
      pipeSockets(daemon, worker, () => {
        Result.try(() => {
          worker.close();
        });
        unregister(envId, daemon);
      });
    };

    /** Pair a worker socket with its env's daemon socket; pipe both ways. */
    const attach = (envId: string, socket: SocketLike) => {
      const envs = Effect.runSync(Ref.get(envsRef));
      const daemon = envs.get(envId);
      if (daemon === undefined) {
        // The daemon may be mid-reconnect: hold the worker briefly and
        // buffer its frames (the env_hello must not be lost — the daemon
        // answers only when it arrives).
        const buffered: string[] = [];
        buffers.set(socket, buffered);
        const onMessage = (data: SocketPayload) => {
          if (!isSocketMessage(data)) {
            return;
          }
          const text = Result.try(() => decodeFrame(data));
          if (Result.isSuccess(text)) {
            buffered.push(text.success);
          }
        };
        socket.on("message", onMessage);
        void Effect.runFork(
          Ref.update(waitingRef, (waiting) => {
            const set = new Set(waiting.get(envId));
            set.add(socket);
            return new Map(waiting).set(envId, set);
          }),
        );
        const drop = (message: string) => {
          buffers.delete(socket);
          socket.off("message", onMessage);
          void Effect.runFork(
            Ref.update(waitingRef, (waiting) => {
              const set = new Set(waiting.get(envId));
              set.delete(socket);
              return new Map(waiting).set(envId, set);
            }),
          );
          failSocket(socket, message);
        };
        socket.once("close", () => {
          buffers.delete(socket);
          socket.off("message", onMessage);
        });
        // A registration within the grace window pairs us; otherwise drop.
        setTimeout(() => {
          const still = Effect.runSync(Ref.get(envsRef)).get(envId);
          if (still === undefined) {
            drop(`no env registered: ${envId.slice(0, 8)}`);
          }
        }, 2000);
        return;
      }
      pipeBoth(envId, socket, daemon);
    };

    const register = (envId: string, socket: SocketLike) => {
      // A replacement registration takes over (the old socket is dead).
      void Effect.runFork(
        Ref.update(envsRef, (envs) => {
          const previous = envs.get(envId);
          if (previous !== undefined && previous !== socket) {
            Result.try(() => {
              previous.close();
            });
          }
          return new Map(envs).set(envId, socket);
        }),
      );
      // Pair any workers that attached before this registration.
      const waiting = Effect.runSync(Ref.get(waitingRef));
      const pending = waiting.get(envId);
      if (pending !== undefined) {
        for (const worker of pending) {
          pipeBoth(envId, worker, socket);
        }
        void Effect.runFork(
          Ref.update(waitingRef, (current) => new Map(current).set(envId, new Set())),
        );
      }
    };

    const handleConnection = (socket: SocketLike) => {
      // The first frame decides: relay_hello (env daemon) or relay_attach.
      const onFirst = (data: SocketPayload) => {
        if (!isSocketMessage(data)) {
          return;
        }
        const parsed = Result.try(() => parseFrame(decodeFrame(data)));
        if (Result.isFailure(parsed)) {
          return;
        }
        if (!isFrameObject(parsed.success)) {
          return;
        }
        const frame = parsed.success;
        if (frame._tag === "relay_hello") {
          const hello = Schema.decodeUnknownResult(RelayHello)(parsed.success);
          if (Result.isFailure(hello)) {
            failSocket(socket, "undecodable relay_hello");
            return;
          }
          socket.off("message", onFirst);
          if (hello.success.version !== ENV_VERSION) {
            failSocket(socket, `relay version mismatch: expected ${ENV_VERSION}`);
            return;
          }
          if (hello.success.token !== options.token) {
            failSocket(socket, "invalid relay token");
            return;
          }
          // The relay's callbacks are outside the Effect runtime: fork the logs.
          void Effect.runFork(log(`env registered: ${hello.success.envId.slice(0, 8)}`));
          register(hello.success.envId, socket);
          socket.once("close", () => {
            unregister(hello.success.envId, socket);
            void Effect.runFork(log(`env unregistered: ${hello.success.envId.slice(0, 8)}`));
          });
          return;
        }
        if (frame._tag === "relay_attach") {
          const decoded = Schema.decodeUnknownResult(RelayAttach)(parsed.success);
          if (Result.isFailure(decoded)) {
            failSocket(socket, "undecodable relay_attach");
            return;
          }
          socket.off("message", onFirst);
          if (decoded.success.version !== ENV_VERSION) {
            failSocket(socket, `relay version mismatch: expected ${ENV_VERSION}`);
            return;
          }
          if (decoded.success.token !== options.token) {
            failSocket(socket, "invalid relay token");
            return;
          }
          attach(decoded.success.envId, socket);
        }
        // Not relay traffic: this socket belongs to the wire server.
      };
      socket.on("message", onFirst);
    };

    const close = Effect.fn("close")(function* () {
      const closed = yield* Ref.get(closedRef);
      if (closed) {
        return;
      }
      yield* Ref.set(closedRef, true);
      const envs = yield* Ref.get(envsRef);
      yield* Effect.forEach(
        [...envs.values()],
        (socket) =>
          Effect.sync(() => {
            socket.close();
          }),
        {
          discard: true,
        },
      );
      yield* Ref.set(envsRef, new Map());
      const waiting = yield* Ref.get(waitingRef);
      const waitingSockets = new Set<SocketLike>();
      for (const sockets of waiting.values()) {
        for (const socket of sockets) {
          waitingSockets.add(socket);
        }
      }
      yield* Effect.forEach(
        [...waitingSockets],
        (socket) =>
          Effect.sync(() => {
            socket.close();
          }),
        {
          discard: true,
        },
      );
      yield* Ref.set(waitingRef, new Map());
    });

    return {
      close,
      handleConnection,
      registered: () => Ref.get(envsRef).pipe(Effect.map((envs) => [...envs.keys()])),
    };
  }),
}) {}
