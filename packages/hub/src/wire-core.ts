/**
 * The hub's wire connection core (wire-core.ts): hello/version auth,
 * stateless command routing, and fan-out — the entire connection
 * discipline of ADR 0004, written against the `SocketLike` surface so
 * the same code serves the node WebSocket server (server.ts, the local
 * spine and tests) and a Durable Object's accepted sockets (the alchemy
 * DO adapter, production/celld).
 *
 * The core owns no sockets and no server: `runConnection` handles one
 * socket for its lifetime, `closeClients` drops every live connection.
 * All semantics live in the `HubShape` it is given.
 */

import { Context, Effect, Option, Ref, Result, Schema, Scope } from "effect";

import {
  CreateThreadResponse,
  DeleteSkillResponse,
  DeleteThreadResponse,
  ErrorEvent,
  EventFrame,
  GetThreadResponse,
  Hello,
  HelloOk,
  ImportSkillResponse,
  ListSkillsResponse,
  ListThreadsResponse,
  RenameThreadResponse,
  ResponseError,
  ResponseOk,
  SessionCommand,
  ThreadChanged,
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
} from "@saku/wire";

import { HubError, messageOf } from "./hub-error.ts";
import type { HubEvent, HubShape } from "./hub.ts";
import type { SocketLike } from "./socket.ts";

const DECODE_COMMAND = Schema.decodeUnknownSync(Schema.Union([Hello, WireCommand]));

/** Whether a decoded command is thread-scoped (session vocabulary vs. hub-level). */
const isSessionCommand = (
  c: SessionCommandType | ThreadCommand | SkillCommand,
): c is SessionCommandType => Schema.is(SessionCommand)(c);

interface Client {
  readonly socket: SocketLike;
  readonly authed: Ref.Ref<boolean>;
}

export interface WireCoreOptions {
  readonly hub: HubShape;
  /** The deployment secret, presented in `hello` (v1: single-owner auth). */
  readonly token: string;
  /** The pid reported in `hello_ok` (node: process.pid; a DO: 0). */
  readonly pid?: number;
}

export interface WireCoreShape {
  /** Handle one accepted socket for its lifetime (scope closes on close). */
  readonly runConnection: (socket: SocketLike) => Effect.Effect<void, never, Scope.Scope>;
  /** Drop every live connection and unsubscribe from the hub. */
  readonly close: () => Effect.Effect<void, never>;
}

export const makeWireCore = (
  options: WireCoreOptions,
): Effect.Effect<WireCoreShape, never, never> =>
  Effect.gen(function* () {
    const { hub, token } = options;
    const pid = options.pid ?? (typeof process !== "undefined" ? process.pid : 0);
    const clientsRef = yield* Ref.make<ReadonlySet<Client>>(new Set());

    const send = (client: Client, event: WireEvent): Effect.Effect<void, never> =>
      Effect.sync(() => {
        // A socket that closed between the check and the send is a no-op;
        // the close handler cleans the client up.
        const sent = Result.try(() => client.socket.send(serializeFrame(event)));
        if (Result.isFailure(sent)) {
          console.warn(`[saku-hub] send failed: ${String(sent.failure)}`);
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

    /** The hub's events → wire frames (the fan-out). */
    const onHubEvent = (event: HubEvent): void => {
      const frame: WireEvent =
        event.type === "thread_changed"
          ? ThreadChanged.make({ thread: event.thread })
          : EventFrame.make({ threadId: event.threadId, event: event.event });
      void Effect.runFork(broadcast(frame));
    };

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
        if (hello.token !== token) {
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
            run = Effect.fail(new HubError({ message: "session command without a threadId" }));
          } else {
            run = hub.runSessionCommand(command.threadId, command.command);
          }
        } else {
          run = runHubCommand(command.command);
        }
        // matchEffect: the success/failure arms are Effects (respond/send).
        yield* Effect.matchEffect(run, {
          onSuccess: (payload) => respond(client, id, payload as ResponsePayload),
          onFailure: (error) => respondCommandFailure(client, id, error),
        });
      });

    const runHubCommand = (
      command: ThreadCommand | SkillCommand,
    ): Effect.Effect<ResponsePayload, HubError, never> =>
      Effect.gen(function* () {
        switch (command._tag) {
          case "list_threads":
            return ListThreadsResponse.make({ threads: yield* hub.listThreads() });
          case "create_thread":
            return CreateThreadResponse.make({
              thread: yield* hub.createThread({
                name: command.name,
                ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
                ...(command.mode === undefined ? {} : { mode: command.mode }),
                ...(command.autoName === undefined ? {} : { autoName: command.autoName }),
              }),
            });
          case "get_thread":
            return GetThreadResponse.make({ thread: yield* hub.getThread(command.threadId) });
          case "rename_thread":
            return RenameThreadResponse.make({
              thread: yield* hub.renameThread(command.threadId, command.name),
            });
          case "delete_thread":
            yield* hub.deleteThread(command.threadId);
            return DeleteThreadResponse.make({});
          case "list_skills":
            return ListSkillsResponse.make({ skills: yield* hub.listSkills() });
          case "import_skill":
            return ImportSkillResponse.make({
              skill: yield* hub.importSkill(command.source, command.scope),
            });
          case "delete_skill":
            yield* hub.deleteSkill(command.id);
            return DeleteSkillResponse.make({});
          default: {
            // Exhaustiveness: a new command tag must be handled here.
            const exhaustive: never = command;
            void exhaustive;
            return yield* Effect.fail(new HubError({ message: "unknown command" }));
          }
        }
      });

    // -- connections ---------------------------------------------------------

    const runConnection = (
      socket: SocketLike,
    ): Effect.Effect<void, never, Scope.Scope> =>
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
          console.error(
            `[saku-hub] socket error: ${error instanceof Error ? error.message : String(error)}`,
          );
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

    // The hub subscription lives for the core's lifetime (the node server
    // closes it on teardown; a DO keeps it for the instance's lifetime).
    const unsubscribe = hub.subscribe(onHubEvent);

    return {
      runConnection,
      close: () =>
        Effect.gen(function* () {
          unsubscribe();
          yield* closeClients();
        }),
    };
  });
