/**
 * The hub DO (hub-do.ts): the control-plane Durable Object of the
 * deployment — one instance named "hub" (ADR 0001). It hosts the entire
 * hub core from `@saku/hub` over DO storage and serves three surfaces
 * through its `fetch`:
 *
 * - `/ws`    — the wire server: consoles' WebSocket connections
 *              (hello/version auth, stateless routing, fan-out)
 * - `/relay` — the env relay: the daemons' outbound registration and the
 *              workers' attaches, piped uninterpreted (ADR 0003)
 * - `/push`  — the thread DOs' JSON channel: reports, session events,
 *              and idle-stop firings
 *
 * Everything durable lives on DO storage through the `KvStore` seam; the
 * worker seam is the thread-DO namespace; provisioning is the default static
 * daemon, the explicit Box adapter (incomplete — ADR 0008), or — once the
 * backend lands — Freestyle (`SAKU_ENV_PROVISIONER=freestyle`, fails loudly
 * until then); the idle-stop window is armed in the thread DOs as durable
 * alarms (the hub's `IdleStopController`), and the fire path runs here.
 */

import { Effect, Match, Option, Schema } from "effect";
import {
  Hub,
  HubRegistry,
  HubRelayCore,
  SkillsStore,
  WireCore,
  workerdSocket,
  HubError,
} from "@saku/hub/core";
import type { HubApi, HubRelayCoreApi, SocketLike, WireCoreApi } from "@saku/hub/core";
import type { SessionWireEvent } from "@saku/wire";
import { BoxApi, BoxProvisioner } from "@saku/hub/providers/box";

import { KvStore } from "@saku/store";
import { varOrDefault } from "./env.ts";
import type { DeploymentEnv } from "./env.ts";
import { threadIdleStop, threadWorkerRef } from "./rpc.ts";
import { decodeHubPush, jsonError, jsonOk, rpcErrorOf } from "./do-protocol.ts";
import { staticProvisioner } from "./static-provisioner.ts";
import { ENV_BUNDLE_BASE64 } from "./generated/env-bundle.ts";

/**
 * A schema that accepts any payload and types it as `T` — the ADR 0005
 * seam the wire client uses for `EventFrame.event`: pi's event
 * vocabulary crosses the wire unvalidated, never re-schemed.
 */
const opaque = <T>() =>
  Schema.declare<T>((_u): _u is T => true, {
    description: "opaque payload, carried unvalidated (ADR 0005)",
  });

/** The boundary where the push channel's opaque event crosses to the projected `SessionWireEvent`. */
const decodeSessionEvent = Schema.decodeUnknownSync(opaque<SessionWireEvent>());

export const IDLE_STOP_DEFAULT_MS = 300_000;

/** The Box adapter with the deployment's key and embedded bundle.
 * Box is incomplete (ADR 0008) — explicit opt-in until Freestyle lands. */
const boxProvisioner = (env: DeploymentEnv) =>
  BoxProvisioner.make({
    log: (message) => Effect.logError(`[hub-do] box: ${message}`),
    // The env daemon bundle is embedded at build time (scripts/
    // embed-env-bundle.ts): a DO cannot read the filesystem.
    readBundle: () =>
      Effect.sync(() => {
        const binary = atob(ENV_BUNDLE_BASE64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.codePointAt(i) ?? 0;
        }
        return new TextDecoder().decode(bytes);
      }),
    remoteMachineProvider: BoxApi.make({ apiKey: env.BOX_API_KEY }),
  });

/**
 * The deployment's provisioner: static is the default configured-daemon
 * mode (dev/celld); Box is explicit and incomplete; Freestyle is the chosen
 * provider of record but fails loudly until its backend lands. Unknown
 * values fail rather than silently selecting a provider.
 */
export const provisionerFor = (env: DeploymentEnv) =>
  Match.value(varOrDefault(env, "SAKU_ENV_PROVISIONER", "static")).pipe(
    Match.when("static", () => Effect.succeed(staticProvisioner(env))),
    Match.when("box", () => Effect.succeed(boxProvisioner(env))),
    Match.when("freestyle", () =>
      Effect.fail(
        new HubError({
          kind: "provisioner",
          message: "freestyle provisioner is not implemented yet — see ADR 0008",
        }),
      ),
    ),
    Match.orElse((value) =>
      Effect.fail(
        new HubError({
          kind: "provisioner",
          message: `unknown env provisioner: ${value}`,
        }),
      ),
    ),
  );

/**
 * The `/push` contract lives in one place (do-protocol.ts): the payload
 * schemas, the envelope helpers, and the decoders both DOs share.
 */

export class SakuHubDO {
  private readonly env: DeploymentEnv;
  private hubPromise: Promise<HubApi> | undefined;
  private wire: WireCoreApi | undefined;
  private relay: HubRelayCoreApi | undefined;
  /** Accepted sockets by workerd `WebSocket` (webSocketMessage routing). */
  private readonly sockets = new Map<WebSocket, SocketLike>();
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: DeploymentEnv) {
    this.state = state;
    this.env = env;
  }

  /**
   * Workerd delivers accepted-socket messages through these DO methods
   * (not event listeners): forward them into the socket adapters, whose
   * listeners the wire/relay cores drive.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.sockets.get(ws)?.receive?.(message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    const socket = this.sockets.get(ws);
    this.sockets.delete(ws);
    socket?.receiveClose?.(code, reason);
  }
  /** The hub core over DO storage, built once per activation (async: the
   * registry and skills store read DO storage at construction). */
  private buildHub() {
    const { state } = this;
    const { env } = this;
    const idleStop = threadIdleStop(env);
    const idleStopMs = Math.trunc(
      Number(varOrDefault(env, "SAKU_IDLE_STOP_MS", String(IDLE_STOP_DEFAULT_MS))),
    );
    return Effect.fn("buildHub")(function* () {
      return yield* Hub.make({
        idleStop,
        idleStopMs,
        provisioner: yield* provisionerFor(env),
        registry: yield* HubRegistry.make(),
        skills: yield* SkillsStore.make(),
        workerRef: threadWorkerRef(env),
      });
    })().pipe(
      // The hub's registry and skills store live on DO storage — the
      // platform boundary (the `KvStore` service, doStorage backend).
      Effect.provide(KvStore.doStorage(state.storage)),
    );
  }

  /**
   * The memoized hub shape. The cache is a promise because the DO's
   * fetch/alarm entry points ARE promise-shaped — that is the platform
   * seam (plain workerd, no alchemy runtime), so `Effect.runPromise`
   * happens here, at the edge, like the CLI's `Effect.runPromise(main())`.
   */
  private async hub() {
    this.hubPromise ??= Effect.runPromise(this.buildHub());
    return await this.hubPromise;
  }

  private async wireCore() {
    // A DO has no process: the hello_ok pid is 0. The runSync is safe
    // because WireCore.make performs no blocking async work (its
    // Effect.gen only builds Refs); only the hub shape above is
    // awaited, since the registry and skills store read DO storage.
    this.wire ??= Effect.runSync(
      WireCore.make({ hub: await this.hub(), pid: 0, token: this.env.DEPLOYMENT_SECRET }),
    );
    return this.wire;
  }

  private relayCore() {
    this.relay ??= Effect.runSync(HubRelayCore.make({ token: this.env.DEPLOYMENT_SECRET }));
    return this.relay;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // The thread DOs' JSON channel.
    if (path === "/push" && request.method === "POST") {
      return await this.handlePush(request);
    }

    // WebSocket surfaces: the wire (consoles) and the relay (daemons).
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonError("malformed", "expected a websocket upgrade");
    }
    if (path !== "/ws" && path !== "/relay") {
      return jsonError("malformed", `unknown path: ${path}`);
    }
    const pair = new WebSocketPair();
    // Workerd's pair is a tuple-like object without an iterator.
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    const socket = workerdSocket(server);
    this.sockets.set(server, socket);
    if (path === "/ws") {
      // The connection handler lives for the socket's lifetime; failures
      // are per-connection (the socket closes, the hub keeps serving).
      const core = await this.wireCore();
      void Effect.runPromise(
        Effect.scoped(core.runConnection(socket)).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.logError(`[hub-do] connection failed: ${String(error)}`),
            onSuccess: () => Effect.void,
          }),
        ),
      );
    } else {
      this.relayCore().handleConnection(socket);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePush(request: Request) {
    // Malformed JSON (the tryPromise catch) and out-of-contract shapes
    // (decodeUnknownOption) both land on `none`: one error response.
    const parsed = await Effect.runPromise(
      Effect.tryPromise({
        catch: () => null,
        try: async () => await request.json(),
      }).pipe(Effect.flatMap((body) => Effect.sync(() => decodeHubPush(body)))),
    );
    if (Option.isNone(parsed)) {
      return jsonError("malformed", "malformed push");
    }
    const push = parsed.value;
    const hub = await this.hub();
    return await Match.value(push).pipe(
      Match.tagsExhaustive({
        idleStopFired: async ({ threadId }) => {
          try {
            await Effect.runPromise(hub.idleStopFired(threadId));
            return jsonOk({});
          } catch (error) {
            const { kind, message } = rpcErrorOf(error);
            return jsonError(kind, message);
          }
        },
        report: ({ threadId, report }) => {
          hub.events.report(threadId, report);
          return jsonOk({});
        },
        sessionEvent: ({ threadId, event, tailSeq }) => {
          // The event is opaque to the hub (ADR 0005) — the same seam
          // the wire client applies to `EventFrame.event`.
          hub.events.sessionEvent(threadId, decodeSessionEvent(event), tailSeq);
          return jsonOk({});
        },
      }),
    );
  }
}
