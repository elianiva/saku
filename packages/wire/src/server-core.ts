/**
 * The wire's server core (server-core.ts): the transport-free connection
 * discipline of ADR 0004 — hello/version auth, stateless command routing,
 * and fan-out — shared by the hub (`hub/wire-core.ts`) and the local
 * daemon (`worker/daemon.ts`), so the protocol's server side lives in one
 * implementation instead of two drifting copies.
 *
 * The core owns no sockets and no server: `runConnection` handles one
 * socket for its lifetime, `broadcast` fans an event out to every authed
 * console, and `close` drops every live connection. All semantics live in
 * the `WireServerHandlers` it is given — the daemon and the hub provide
 * their own command handlers, and the auth token is resolved per hello
 * (the daemon re-reads auth.json; the hub answers a constant).
 *
 * This module imports no transport (`ws` etc.) — the wire package stays
 * browser-safe, and the core is exported via the `@saku/wire/server`
 * subpath so the frontend bundle never sees it. Node `ws` sockets and the
 * hub's `SocketLike` adapters satisfy `ServerSocket` structurally.
 */

import { Effect, Ref, Result, Schema, Scope } from "effect";

import {
  ErrorEvent,
  Hello,
  HelloOk,
  ResponseError,
  ResponseOk,
  SessionCommand,
  WIRE_VERSION,
  WireCommand,
  decodeFrame,
  parseFrame,
  serializeFrame,
  type ResponsePayload,
  type SessionCommand as SessionCommandType,
  type SkillCommand,
  type ThreadCommand,
  type WireEvent,
} from "./index.ts";

/** The user-facing message of any failure the wire produces (the canonical copy). */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A protocol violation detected by the server core (a malformed command frame). */
export class WireServerError extends Schema.TaggedError<WireServerError>()("WireServerError", {
  code: Schema.Literals(["missing_thread_id"]),
  message: Schema.String,
}) {}

/** The transport surface the core drives; node `ws` sockets and the hub's
 * `SocketLike` adapters satisfy it structurally. */
export interface ServerSocket {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly on: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
  readonly once: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
  readonly off: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
}

/** The command handlers the core routes to (the daemon's and the hub's own). */
export interface WireServerHandlers {
  readonly runHubCommand: (
    command: ThreadCommand | SkillCommand,
  ) => Effect.Effect<ResponsePayload, unknown, never>;
  readonly runSessionCommand: (
    threadId: string,
    command: SessionCommand,
  ) => Effect.Effect<ResponsePayload, unknown, never>;
}

export interface WireServerOptions {
  /** Resolves the auth token per hello (the daemon re-reads auth.json; the hub answers a constant). */
  readonly token: () => Effect.Effect<string, never, never>;
  /** The pid reported in `hello_ok` (node: process.pid; a DO: 0). */
  readonly pid?: number;
  readonly handlers: WireServerHandlers;
  /** Send/error diagnostics (the daemon's log; the hub's warn). */
  readonly log?: (message: string) => void;
}

export interface WireServerShape {
  /** Handle one accepted socket for its lifetime (scope closes on close). */
  readonly runConnection: (socket: ServerSocket) => Effect.Effect<void, never, Scope.Scope>;
  /** Fan one event out to every authed console. */
  readonly broadcast: (event: WireEvent) => Effect.Effect<void, never>;
  /** Drop every live connection. */
  readonly close: () => Effect.Effect<void, never>;
}

interface Client {
  readonly socket: ServerSocket;
  readonly authed: Ref.Ref<boolean>;
}

const DECODE_COMMAND = Schema.decodeUnknownSync(Schema.Union([Hello, WireCommand]));

/** Whether a decoded command is thread-scoped (session vocabulary vs. hub-level). */
const isSessionCommand = (
  c: SessionCommandType | ThreadCommand | SkillCommand,
): c is SessionCommandType => Schema.is(SessionCommand)(c);

export const makeWireServer = (
  options: WireServerOptions,
): Effect.Effect<WireServerShape, never, never> =>
  Effect.gen(function* () {
    const pid = options.pid ?? (typeof process !== "undefined" ? process.pid : 0);
    const clientsRef = yield* Ref.make<ReadonlySet<Client>>(new Set());

    const log = (message: string): void => {
      if (options.log !== undefined) options.log(message);
    };

    const send = (client: Client, event: WireEvent): Effect.Effect<void, never> =>
      Effect.sync(() => {
        // A socket that closed between the check and the send is a no-op;
        // the close handler cleans the client up.
        const sent = Result.try(() => client.socket.send(serializeFrame(event)));
        if (Result.isFailure(sent)) {
          log(`send failed: ${String(sent.failure)}`);
        }
      });

    const broadcast = (event: WireEvent): Effect.Effect<void, never> =>
      Ref.get(clientsRef).pipe(
        Effect.flatMap((clients) =>
          Effect.forEach(
            clients,
            (client) =>
              Ref.get(client.authed).pipe(
                Effect.flatMap((authed) => (authed ? send(client, event) : Effect.void)),
              ),
            { discard: true },
          ),
        ),
      );

    // -- command routing -----------------------------------------------------

    const handleHello = (client: Client, hello: Hello): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (hello.version !== WIRE_VERSION) {
          yield* send(
            client,
            ErrorEvent.make({ message: `version mismatch: expected ${WIRE_VERSION}` }),
          );
          client.socket.close();
          return;
        }
        const expected = yield* options.token();
        if (hello.token !== expected) {
          yield* send(client, ErrorEvent.make({ message: "invalid token" }));
          client.socket.close();
          return;
        }
        yield* Ref.set(client.authed, true);
        yield* send(client, HelloOk.make({ pid, version: WIRE_VERSION }));
      });

    const respond = (
      client: Client,
      id: string | undefined,
      payload: ResponsePayload,
    ): Effect.Effect<void, never> => {
      if (id === undefined) return Effect.void;
      return send(client, ResponseOk.make({ id, ok: true, payload }));
    };

    const respondCommandFailure = (
      client: Client,
      id: string | undefined,
      error: unknown,
    ): Effect.Effect<void, never> => {
      const message = messageOf(error);
      if (id === undefined) return send(client, ErrorEvent.make({ message }));
      return send(client, ResponseError.make({ id, ok: false, error: message }));
    };

    const handleCommand = (client: Client, command: WireCommand): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const authed = yield* Ref.get(client.authed);
        if (!authed) {
          yield* send(client, ErrorEvent.make({ message: "hello first" }));
          return;
        }
        const id = command.id;
        // Routing by command kind: session commands are thread-scoped; threads
        // and skills are hub-level. A session command without a threadId is a
        // protocol error, not a hub command.
        let run: Effect.Effect<unknown, unknown, never>;
        if (isSessionCommand(command.command)) {
          if (command.threadId === undefined) {
            run = Effect.fail(
              new WireServerError({
                code: "missing_thread_id",
                message: "session command without a threadId",
              }),
            );
          } else {
            run = options.handlers.runSessionCommand(command.threadId, command.command);
          }
        } else {
          run = options.handlers.runHubCommand(command.command);
        }
        // matchEffect: the success/failure arms are Effects (respond/send);
        // handler failures are stringified at this frame boundary.
        yield* Effect.matchEffect(run, {
          onSuccess: (payload) => respond(client, id, payload as ResponsePayload),
          onFailure: (error) => respondCommandFailure(client, id, error),
        });
      });

    // -- connections ---------------------------------------------------------

    const runConnection = (socket: ServerSocket): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const authed = yield* Ref.make(false);
        const client: Client = { socket, authed };
        yield* Ref.update(clientsRef, (clients) => new Set(clients).add(client));
        yield* Effect.addFinalizer(() =>
          Ref.update(clientsRef, (clients) => {
            const next = new Set(clients);
            next.delete(client);
            return next;
          }),
        );
        const onMessage = (data: unknown): void => {
          const value = Result.try(() => parseFrame(decodeFrame(data)));
          if (Result.isFailure(value)) {
            void Effect.runFork(send(client, ErrorEvent.make({ message: "malformed JSON frame" })));
            return;
          }
          const decoded = Result.try(() => DECODE_COMMAND(value.success));
          if (Result.isFailure(decoded)) {
            void Effect.runFork(send(client, ErrorEvent.make({ message: "undecodable message" })));
            return;
          }
          if (decoded.success._tag === "hello") {
            void Effect.runFork(handleHello(client, decoded.success));
          } else {
            void Effect.runFork(handleCommand(client, decoded.success));
          }
        };
        const onError = (error: unknown): void => {
          log(`socket error: ${error instanceof Error ? error.message : String(error)}`);
        };
        socket.on("message", onMessage);
        socket.on("error", onError);
        // Resolve when the socket closes; the scope's finalizer then drops the client.
        yield* Effect.callback<void>((resume) => {
          const onClose = (): void => {
            resume(Effect.void);
          };
          socket.once("close", onClose);
          return Effect.sync(() => socket.off("close", onClose));
        });
      });

    // -- lifecycle -----------------------------------------------------------

    const closeClients = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const clients = yield* Ref.get(clientsRef);
        yield* Effect.forEach(clients, (client) => Effect.sync(() => client.socket.close()), {
          discard: true,
        });
        yield* Ref.set(clientsRef, new Set());
      });

    return {
      runConnection,
      broadcast,
      close: closeClients,
    };
  });

// The node-only WebSocket server transport — part of the `@saku/wire/server`
// subpath, never the main entry (the frontend bundles the main entry for
// the browser).
export * from "./ws-server.ts";
