/**
 * The env daemon's relay client (relay.ts): how the user's machine —
 * which has no open ports — registers with the hub (ADR 0003).
 *
 * The daemon dials out to the hub's relay server and presents
 * `relay_hello {envId, token, version}`; the hub records the socket. When
 * a worker-side `RemoteEnv` attaches (`relay_attach`), the hub pipes the
 * two sockets together, so the daemon serves its normal env protocol
 * (hello, requests, streams) on the relay socket exactly as it would on
 * its local server — `handleEnvConnection` is shared.
 *
 * The registration is a loop, not a one-shot: the connection is expected
 * to drop (hub restart, network blip, machine sleep), so the client
 * reconnects with a fixed backoff until stopped.
 */

import { WebSocket } from "ws";
import { Context, Effect, Fiber, Ref, Result } from "effect";

import { serializeFrame } from "@saku/wire";
import { ENV_VERSION, RelayHello } from "./protocol.ts";
import type { EnvHello } from "./protocol.ts";
import { handleEnvConnection } from "./daemon.ts";
import type { EnvConnectionContext } from "./daemon.ts";

const BACKOFF_MS = 1000;

export interface RelayClientOptions {
  /** The hub's relay server URL. */
  readonly url: string;
  /** This env's id (minted by the CLI config; the hub knows it by this). */
  readonly envId: string;
  /** The relay credential: the deployment secret (v1: shared, single-owner). */
  readonly token: string;
  /** The env protocol hello this connection presents after the attach. */
  readonly hello: Pick<EnvHello, "token" | "version" | "cwd">;
  readonly fs: EnvConnectionContext["fs"];
  readonly log?: (message: string) => Effect.Effect<void>;
}

export interface RelayClientApi {
  /** Whether a registration socket is currently open. */
  readonly connected: () => Effect.Effect<boolean>;
  /** Stop the loop and close the socket. */
  readonly stop: () => Effect.Effect<void>;
}

/** One registration attempt: dial, hello, then serve until the socket dies. */
const runRegistration = Effect.fn("runRegistration")(function* runRegistration(
  options: RelayClientOptions,
  ctx: EnvConnectionContext,
) {
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(options.url)),
    (ws) =>
      Effect.sync(() => {
        ws.close();
      }),
  );
  // Wait for the socket to open, send relay_hello, and hand the socket
  // straight to the shared env connection handler: the hub's next frame
  // is either an env_error (rejected registration — surfaced by the
  // handler) or a worker's piped env_hello (serve it).
  const outcome = yield* Effect.callback<Result.Result<void, string>>((resume) => {
    let settled = false;
    const finish = (result: Result.Result<void, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      resume(Effect.succeed(result));
    };
    const onError = (error: Error) => {
      finish(Result.fail(error.message));
    };
    const onClose = () => {
      finish(Result.fail("relay closed before the registration"));
    };
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.on("open", () => {
      socket.send(
        serializeFrame(
          RelayHello.make({ envId: options.envId, token: options.token, version: ENV_VERSION }),
        ),
      );
      finish(Result.void);
    });
    // The registration effect completed: drop the socket listeners.
    return Effect.sync(() => {
      socket.off("error", onError);
      socket.off("close", onClose);
    });
  });
  if (Result.isFailure(outcome)) {
    yield* options.log?.(`relay failed: ${outcome.failure}`) ?? Effect.void;
    return false;
  }
  yield* options.log?.(`relay registered (${options.envId.slice(0, 8)})`) ?? Effect.void;
  // Registration accepted: serve the env protocol on this socket until it
  // drops; the hub pipes a worker's attach onto it.
  yield* handleEnvConnection(socket, ctx);
  return true;
});

/** The reconnect loop: `EnvRelayClient.make(options)` starts it in the caller's scope. */
export class EnvRelayClient extends Context.Service<EnvRelayClient, RelayClientApi>()(
  "EnvRelayClient",
  {
    make: Effect.fn("EnvRelayClient.make")(function* make(options: RelayClientOptions) {
      const log = options.log ?? (() => Effect.void);
      const ctx: EnvConnectionContext = {
        cwd: options.hello.cwd ?? process.cwd(),
        fs: options.fs,
        log,
        token: options.hello.token,
      };
      const runningRef = yield* Ref.make(true);
      const connectedRef = yield* Ref.make(false);
      const loop = Effect.gen(function* loop() {
        while (yield* Ref.get(runningRef)) {
          const registered = yield* runRegistration(options, ctx);
          yield* Ref.set(connectedRef, registered);
          if (!(yield* Ref.get(runningRef))) {
            return;
          }
          yield* log("relay disconnected; reconnecting");
          yield* Effect.sleep(`${BACKOFF_MS} millis`);
        }
      });
      // The loop fiber: forked scoped — the scope's exit interrupts it.
      const fiber = yield* Effect.forkScoped(loop);
      yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
      return {
        connected: () => Ref.get(connectedRef),
        stop: Effect.fn("stop")(function* stop() {
          yield* Ref.set(runningRef, false);
          yield* Fiber.interrupt(fiber);
        }),
      };
    }),
  },
) {}
