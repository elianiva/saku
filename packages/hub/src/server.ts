/**
 * The hub's wire server (server.ts): WebSocket JSONL transport for the hub
 * core (ADR 0004) — the same connection discipline the local daemon runs:
 * hello/version handshake, token auth, stateless command routing, and
 * fan-out of `thread_changed` + session events to every authed console.
 *
 * The server is a thin adapter: all semantics live in the `HubShape` it is
 * given (routing, registry, skills, worker seam); the DO adapter of M4 will
 * adapt the same core to the alchemy entry point.
 */

import { WebSocketServer, type WebSocket } from "ws";
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
import { makeHubRelay, type HubRelayShape } from "./relay.ts";

const DECODE_COMMAND = Schema.decodeUnknownSync(Schema.Union([Hello, WireCommand]));

/** Whether a decoded command is thread-scoped (session vocabulary vs. hub-level). */
const isSessionCommand = (
  c: SessionCommandType | ThreadCommand | SkillCommand,
): c is SessionCommandType => Schema.is(SessionCommand)(c);

interface Client {
  readonly socket: WebSocket;
  readonly authed: Ref.Ref<boolean>;
}

export interface HubServerOptions {
  readonly hub: HubShape;
  /** The deployment secret, presented in `hello` (v1: single-owner auth). */
  readonly token: string;
  /** Serve the env relay too (the daemons' outbound registration). */
  readonly relay?: boolean;
}

export interface HubServerShape {
  /** The ws:// URL the hub listens on (consoles). */
  readonly url: string;
  /** The ws:// URL the env relay listens on (daemons + workers). */
  readonly relayUrl: string | null;
  /** Stop the server: drop clients, unsubscribe, close the sockets. */
  readonly close: () => Effect.Effect<void, never>;
}

/**
 * Build the wire server: refs, then handlers as closures over them, then
 * the startup sequence (listen, subscribe). The shape mirrors the local
 * daemon's `makeSakuDaemon` — the two implementations of the wire's server
 * side share the connection discipline, so the protocol's contract is
 * exercised by both until the rework lands (plan 0001).
 */
export const makeHubServer = (
  options: HubServerOptions,
): Effect.Effect<HubServerShape, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const { hub, token } = options;
    // The env relay: a separate port for M3 (the DO adapter of M4
    // multiplexes both behind the deployment's domain).
    const relay: Option.Option<HubRelayShape> =
      options.relay === true
        ? Option.some(yield* makeHubRelay({ token }))
        : Option.none();
    const clientsRef = yield* Ref.make<ReadonlySet<Client>>(new Set());
    const closedRef = yield* Ref.make(false);
    const serverRef = yield* Ref.make<Option.Option<WebSocketServer>>(Option.none());

    const log = (message: string): void => {
      // The lint gate allows warn/error only; server failures are the
      // interesting events (the URL is returned to the caller, not logged).
      console.error(`[saku-hub] ${message}`);
    };

    // -- connections ---------------------------------------------------------

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
        yield* send(client, HelloOk.make({ pid: process.pid, version: WIRE_VERSION }));
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

    const runConnection = (socket: WebSocket): Effect.Effect<void, never, Scope.Scope> =>
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
        const onError = (error: Error): void => {
          log(`socket error: ${error.message}`);
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

    const handleConnection = (socket: WebSocket): void => {
      void Effect.runFork(Effect.scoped(runConnection(socket)));
    };

    // -- lifecycle -----------------------------------------------------------

    const close = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const closed = yield* Ref.get(closedRef);
        if (closed) return;
        yield* Ref.set(closedRef, true);
        unsubscribe();
        const clients = yield* Ref.get(clientsRef);
        yield* Effect.forEach(clients, (client) => Effect.sync(() => client.socket.close()), {
          discard: true,
        });
        yield* Ref.set(clientsRef, new Set());
        const server = yield* Ref.get(serverRef);
        if (Option.isSome(server)) {
          yield* Effect.callback<void>((resume) => {
            server.value.close(() => resume(Effect.void));
            return Effect.void;
          });
        }
        if (Option.isSome(relay)) {
          yield* relay.value.close();
        }
      });

    // -- startup -------------------------------------------------------------

    const unsubscribe = hub.subscribe(onHubEvent);
    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket) => handleConnection(socket));
      server.on("error", (error) => {
        log(`server error: ${error.message}`);
        resume(Effect.fail(error));
      });
      server.on("listening", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(new Error("no listening address")));
          return;
        }
        const url = `ws://127.0.0.1:${address.port}`;
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.close();
      });
    });
    yield* Ref.set(serverRef, Option.some(server));
    yield* Effect.addFinalizer(() => close());
    const address = server.address();
    const url =
      address !== null && typeof address !== "string" ? `ws://127.0.0.1:${address.port}` : "";
    return {
      url,
      relayUrl: Option.isSome(relay) ? relay.value.url : null,
      close,
    };
  });
