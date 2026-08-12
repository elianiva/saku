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
 * same credential the wire's `hello` uses. M3 serves the relay on its own
 * WebSocket port (the wire server and the relay server are separate);
 * the alchemy DO adapter (M4) multiplexes both behind the single domain.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { Effect, Ref, Result, Schema, Scope } from "effect";

import { decodeFrame, parseFrame, serializeFrame } from "@saku/wire";
import { ENV_VERSION, EnvErrorFrame, RelayAttach, RelayHello } from "@saku/env";

const DECODE_HELLO = Schema.decodeUnknownSync(RelayHello);
const DECODE_ATTACH = Schema.decodeUnknownSync(RelayAttach);

export interface RelayServerOptions {
  /** The deployment secret both sides present in their first frame. */
  readonly token: string;
  readonly log?: (message: string) => void;
}

export interface HubRelayShape {
  /** The ws:// URL env daemons and RemoteEnvs connect to. */
  readonly url: string;
  /** The envIds currently registered. */
  readonly registered: () => Effect.Effect<readonly string[], never, never>;
  /** Stop the relay: drop all sockets, close the server. */
  readonly close: () => Effect.Effect<void, never>;
}

/** Pipe one socket's frames onto the other; both die together. */
const pipeSockets = (
  from: WebSocket,
  to: WebSocket,
  cleanup: () => void,
): (() => void) => {
  const onMessage = (data: unknown): void => {
    // A dead peer between the check and the send is a no-op; the close
    // handler tears both sides down.
    Result.try(() => to.send(data as string));
  };
  const onClose = (): void => {
    cleanup();
    Result.try(() => to.close());
  };
  from.on("message", onMessage);
  from.once("close", onClose);
  return () => {
    from.off("message", onMessage);
    from.off("close", onClose);
  };
};

export const makeHubRelay = (
  options: RelayServerOptions,
): Effect.Effect<HubRelayShape, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const log = options.log ?? (() => {});
    const envsRef = yield* Ref.make<Map<string, WebSocket>>(new Map());
    const waitingRef = yield* Ref.make<Map<string, Set<WebSocket>>>(new Map());
    const closedRef = yield* Ref.make(false);

    const failSocket = (socket: WebSocket, message: string): void => {
      socket.send(serializeFrame(EnvErrorFrame.make({ message })));
      socket.close();
    };

    /** Remove the env's registration (its socket closed). */
    const unregister = (envId: string, socket: WebSocket): void => {
      void Effect.runFork(
        Ref.update(envsRef, (envs) => {
          if (envs.get(envId) !== socket) return envs;
          const next = new Map(envs);
          next.delete(envId);
          return next;
        }),
      );
    };

    // Frames a worker sends while waiting for its env's daemon to register.
    const buffers = new Map<WebSocket, unknown[]>();

    /** Pair a worker socket with its env's daemon socket; pipe both ways. */
    const attach = (envId: string, socket: WebSocket): void => {
      const envs = Effect.runSync(Ref.get(envsRef));
      const daemon = envs.get(envId);
      if (daemon === undefined) {
        // The daemon may be mid-reconnect: hold the worker briefly and
        // buffer its frames (the env_hello must not be lost — the daemon
        // answers only when it arrives).
        const buffered: unknown[] = [];
        buffers.set(socket, buffered);
        const onMessage = (data: unknown): void => {
          buffered.push(data);
        };
        socket.on("message", onMessage);
        void Effect.runFork(
          Ref.update(waitingRef, (waiting) => {
            const set = new Set(waiting.get(envId) ?? []);
            set.add(socket);
            return new Map(waiting).set(envId, set);
          }),
        );
        const drop = (message: string): void => {
          buffers.delete(socket);
          socket.off("message", onMessage);
          void Effect.runFork(
            Ref.update(waitingRef, (waiting) => {
              const set = new Set(waiting.get(envId) ?? []);
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
          if (still === undefined) drop(`no env registered: ${envId.slice(0, 8)}`);
        }, 2000);
        return;
      }
      pipeBoth(envId, socket, daemon);
    };

    /** Pipe worker ⇄ daemon; either side dropping closes the other. */
    const pipeBoth = (envId: string, worker: WebSocket, daemon: WebSocket): void => {
      // Flush anything the worker sent while it was waiting for this daemon.
      const buffered = buffers.get(worker);
      if (buffered !== undefined) {
        buffers.delete(worker);
        for (const frame of buffered) {
          Result.try(() => daemon.send(frame as string));
        }
      }
      pipeSockets(worker, daemon, () => {
        Result.try(() => daemon.close());
        detachFromWorker(envId, worker);
      });
      pipeSockets(daemon, worker, () => {
        Result.try(() => worker.close());
        unregister(envId, daemon);
      });
    };

    const detachFromWorker = (envId: string, socket: WebSocket): void => {
      void Effect.runFork(
        Ref.update(waitingRef, (waiting) => {
          const set = waiting.get(envId);
          if (set === undefined || !set.has(socket)) return waiting;
          const next = new Set(set);
          next.delete(socket);
          return new Map(waiting).set(envId, next);
        }),
      );
    };

    const register = (envId: string, socket: WebSocket): void => {
      // A replacement registration takes over (the old socket is dead).
      void Effect.runFork(
        Ref.update(envsRef, (envs) => {
          const previous = envs.get(envId);
          if (previous !== undefined && previous !== socket) {
            Result.try(() => previous.close());
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
          Ref.update(waitingRef, (waiting) => new Map(waiting).set(envId, new Set())),
        );
      }
    };

    const handleConnection = (socket: WebSocket): void => {
      // The first frame decides: relay_hello (env daemon) or relay_attach.
      const onFirst = (data: unknown): void => {
        const parsed = Result.try(() => parseFrame(decodeFrame(data)));
        if (Result.isFailure(parsed)) return;
        if (typeof parsed.success !== "object" || parsed.success === null) return;
        const frame = parsed.success as { _tag?: string };
        if (frame._tag === "relay_hello") {
          const hello = Result.try(() => DECODE_HELLO(parsed.success));
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
          log(`env registered: ${hello.success.envId.slice(0, 8)}`);
          register(hello.success.envId, socket);
          socket.once("close", () => {
            unregister(hello.success.envId, socket);
            log(`env unregistered: ${hello.success.envId.slice(0, 8)}`);
          });
          return;
        }
        if (frame._tag === "relay_attach") {
          const decoded = Result.try(() => DECODE_ATTACH(parsed.success));
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
          return;
        }
        // Not relay traffic: this socket belongs to the wire server.
      };
      socket.on("message", onFirst);
    };

    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket) => handleConnection(socket));
      server.on("error", (error) => {
        log(`relay error: ${error.message}`);
        resume(Effect.fail(error));
      });
      server.on("listening", () => resume(Effect.succeed(server)));
      return Effect.sync(() => {
        server.close();
      });
    });
    const address = server.address();
    const url =
      address !== null && typeof address !== "string" ? `ws://127.0.0.1:${address.port}` : "";
    const close = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const closed = yield* Ref.get(closedRef);
        if (closed) return;
        yield* Ref.set(closedRef, true);
        const envs = yield* Ref.get(envsRef);
        yield* Effect.forEach([...envs.values()], (socket) => Effect.sync(() => socket.close()), {
          discard: true,
        });
        yield* Ref.set(envsRef, new Map());
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          return Effect.void;
        });
      });
    return {
      url,
      registered: () => Ref.get(envsRef).pipe(Effect.map((envs) => [...envs.keys()])),
      close,
    };
  });
