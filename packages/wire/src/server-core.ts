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

import type { Scope } from "effect";
import { Context, Effect, Ref, Result, Schema } from "effect";

import { ErrorEvent, ResponseError, ResponseOk, WireCommand } from "./envelope.ts";
import type { WireEvent } from "./envelope.ts";
import { Hello, HelloOk } from "./hello.ts";
import { decodeFrame, isSocketMessage, parseFrame, serializeFrame } from "./transport.ts";
import type { SocketMessage } from "./transport.ts";
import type { PiSessionCommand } from "./pi-sessions.ts";
import type { ProjectCommand } from "./projects.ts";
import type { SkillCommand } from "./skills.ts";
import type { ThreadCommand } from "./thread.ts";
import type { ResponsePayload } from "./session.ts";
import { SessionCommand } from "./session.ts";
import { WIRE_VERSION } from "./version.ts";
import { WireServerError } from "./wire-server-error.ts";

export { WireServerError } from "./wire-server-error.ts";

/** The user-facing message of any failure the wire produces (the canonical copy). */
export const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Payload of a close event: the code/reason the peer sent, when known. */
interface ClosePayload {
  readonly code?: number | undefined;
  readonly reason?: string | undefined;
}

/** What a server socket listener receives: message data, an error, or a close. */
type ServerSocketData = SocketMessage | Error | ClosePayload | undefined;

/** The transport surface the core drives; node `ws` sockets and the hub's
 * `SocketLike` adapters satisfy it structurally. */
export interface ServerSocket {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly on: (
    event: "message" | "error" | "close",
    listener: (data: ServerSocketData) => void,
  ) => void;
  readonly once: (
    event: "message" | "error" | "close",
    listener: (data: ServerSocketData) => void,
  ) => void;
  readonly off: (
    event: "message" | "error" | "close",
    listener: (data: ServerSocketData) => void,
  ) => void;
}

/** The command handlers the core routes to (the daemon's and the hub's own). */
export interface WireServerHandlers {
  readonly runHubCommand: (
    command: ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand,
  ) => Effect.Effect<ResponsePayload, unknown>;
  readonly runSessionCommand: (
    threadId: string,
    command: SessionCommand,
  ) => Effect.Effect<ResponsePayload, unknown>;
}

export interface WireServerOptions {
  /** Resolves the auth token per hello (the daemon re-reads auth.json; the hub answers a constant). */
  readonly token: () => Effect.Effect<string>;
  /** The pid reported in `hello_ok` (node: process.pid; a DO: 0). */
  readonly pid?: number;
  readonly handlers: WireServerHandlers;
  /** Send/error diagnostics (the daemon's log; the hub's warn). */
  readonly log?: (message: string) => Effect.Effect<void>;
}

export interface WireServerApi {
  /** Handle one accepted socket for its lifetime (scope closes on close). */
  readonly runConnection: (socket: ServerSocket) => Effect.Effect<void, never, Scope.Scope>;
  /** Fan one event out to every authed console. */
  readonly broadcast: (event: WireEvent) => Effect.Effect<void>;
  /** Drop every live connection. */
  readonly close: () => Effect.Effect<void>;
}

interface Client {
  readonly socket: ServerSocket;
  readonly authed: Ref.Ref<boolean>;
}

const DECODE_COMMAND = Schema.decodeUnknownSync(Schema.Union([Hello, WireCommand]));

/** Whether a decoded command is thread-scoped (session vocabulary vs. hub-level). */
const isSessionCommand = (
  c: SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand,
): c is SessionCommand => Schema.is(SessionCommand)(c);

/** Whether the `process` global exists (node yes; workerd no). */
const hasProcess = (value: typeof process | undefined): value is typeof process =>
  value !== undefined;

/** The connection's close carries no payload. */
const NO_PAYLOAD = undefined;

/** The wire's server core: the shared transport-free connection discipline. */
export class WireServer extends Context.Service<WireServer, WireServerApi>()("WireServer", {
  make: Effect.fn("WireServer.make")(function* make(options: WireServerOptions) {
    const pid = options.pid ?? (hasProcess(process) ? process.pid : 0);
    const clientsRef = yield* Ref.make<ReadonlySet<Client>>(new Set());

    const log = (message: string) =>
      options.log === undefined ? Effect.void : options.log(message);

    const send = Effect.fn("send")(function* send(client: Client, event: WireEvent) {
      // A socket that closed between the check and the send is a no-op;
      // the close handler cleans the client up.
      const sent = Result.try(() => {
        client.socket.send(serializeFrame(event));
      });
      if (Result.isFailure(sent)) {
        yield* log(`send failed: ${String(sent.failure)}`);
      }
    });

    const broadcast = (event: WireEvent) =>
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

    const handleHello = Effect.fn("handleHello")(function* handleHello(
      client: Client,
      hello: Hello,
    ) {
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

    const respond = (client: Client, id: string | undefined, payload: ResponsePayload) =>
      id === undefined ? Effect.void : send(client, ResponseOk.make({ id, ok: true, payload }));

    const respondCommandFailure = (client: Client, id: string | undefined, cause: unknown) => {
      const message = messageOf(cause);
      if (id === undefined) {
        return send(client, ErrorEvent.make({ message }));
      }
      return send(client, ResponseError.make({ error: message, id, ok: false }));
    };

    const handleCommand = Effect.fn("handleCommand")(function* handleCommand(
      client: Client,
      command: WireCommand,
    ) {
      const authed = yield* Ref.get(client.authed);
      if (!authed) {
        yield* send(client, ErrorEvent.make({ message: "hello first" }));
        return;
      }
      const { id } = command;
      // Routing by command kind: session commands are thread-scoped; threads
      // and skills are hub-level. A session command without a threadId is a
      // protocol error, not a hub command.
      let run: Effect.Effect<ResponsePayload, unknown>;
      if (isSessionCommand(command.command)) {
        run =
          command.threadId === undefined
            ? Effect.fail(
                new WireServerError({
                  code: "missing_thread_id",
                  message: "session command without a threadId",
                }),
              )
            : options.handlers.runSessionCommand(command.threadId, command.command);
      } else {
        run = options.handlers.runHubCommand(command.command);
      }
      // matchEffect: the success/failure arms are Effects (respond/send);
      // handler failures are stringified at this frame boundary.
      yield* Effect.matchEffect(run, {
        onFailure: (error) => respondCommandFailure(client, id, error),
        onSuccess: (payload) => respond(client, id, payload),
      });
    });

    const runConnection = Effect.fn("runConnection")(function* runConnection(socket: ServerSocket) {
      const authed = yield* Ref.make(false);
      const client: Client = { authed, socket };
      yield* Ref.update(clientsRef, (clients) => new Set(clients).add(client));
      yield* Effect.addFinalizer(() =>
        Ref.update(clientsRef, (clients) => {
          const next = new Set(clients);
          next.delete(client);
          return next;
        }),
      );
      const onMessage = (data: ServerSocketData) => {
        if (!isSocketMessage(data)) {
          return;
        }
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
        void Effect.runFork(
          decoded.success._tag === "hello"
            ? handleHello(client, decoded.success)
            : handleCommand(client, decoded.success),
        );
      };
      const onError = (cause: unknown) => {
        // The socket callback is outside the Effect runtime: fork the log.
        void Effect.runFork(
          log(`socket error: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      };
      socket.on("message", onMessage);
      socket.on("error", onError);
      // Resolve when the socket closes; the scope's finalizer then drops the client.
      yield* Effect.callback<undefined>((resume) => {
        const onClose = () => {
          resume(Effect.succeed(NO_PAYLOAD));
        };
        socket.once("close", onClose);
        return Effect.sync(() => {
          socket.off("close", onClose);
        });
      });
    });

    const closeClients = Effect.fn("closeClients")(function* closeClients() {
      const clients = yield* Ref.get(clientsRef);
      yield* Effect.forEach(
        clients,
        (client) =>
          Effect.sync(() => {
            client.socket.close();
          }),
        {
          discard: true,
        },
      );
      yield* Ref.set(clientsRef, new Set());
    });

    return {
      broadcast,
      close: closeClients,
      runConnection,
    };
  }),
}) {}

// The node-only WebSocket server transport — part of the `@saku/wire/server`
// subpath, never the main entry (the frontend bundles the main entry for
// the browser).
export { listenWs, WsServerError, wsUrlOf } from "./ws-server.ts";
