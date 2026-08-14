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
 * worker seam is the thread-DO namespace; provisioning is the Box
 * provisioner (incomplete — ADR 0008), the static one
 * (`SAKU_ENV_PROVISIONER=static`), or — once the backend lands — Freestyle
 * (`SAKU_ENV_PROVISIONER=freestyle`, fails loudly until then); the
 * idle-stop window is armed in the thread DOs as durable alarms (the
 * hub's `IdleStopController`), and the fire path runs here.
 */

import { Effect, Match, Option } from "effect";
import {
  Hub,
  HubRegistry,
  HubRelayCore,
  SkillsStore,
  Provisioner,
  WireCore,
  BoxApi,
  workerdSocket,
  HubError,
  type EnvProvisioner,
  type HubShape,
  type HubRelayCoreShape,
  type SocketLike,
  type WireCoreShape,
} from "@saku/hub/core";
import type { SessionWireEvent } from "@saku/wire";

import { KvStore } from "@saku/store";
import { varOrDefault, type DeploymentEnv } from "./env.ts";
import { threadIdleStop, threadWorkerRef } from "./rpc.ts";
import { decodeHubPush, jsonError, jsonOk, readBody, rpcErrorOf } from "./do-protocol.ts";
import { staticProvisioner } from "./static-provisioner.ts";
import { ENV_BUNDLE_BASE64 } from "./generated/env-bundle.ts";

export const IDLE_STOP_DEFAULT_MS = 300_000;

/** The Box provisioner with the deployment's key and embedded bundle.
 * Box is incomplete (ADR 0008) — kept selectable until Freestyle lands. */
const boxProvisioner = (env: DeploymentEnv) =>
  Provisioner.make({
    boxApi: BoxApi.make({ apiKey: env.BOX_API_KEY }),
    // The env daemon bundle is embedded at build time (scripts/
    // embed-env-bundle.ts): a DO cannot read the filesystem.
    readBundle: () =>
      Effect.sync(() => {
        const binary = atob(ENV_BUNDLE_BASE64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }),
    log: (message) => Effect.logError(`[hub-do] box: ${message}`),
  });

/**
 * The deployment's provisioner: `SAKU_ENV_PROVISIONER=static` opts into
 * the configured-daemon mode (dev/celld); `freestyle` is the chosen
 * sandbox provider (ADR 0008) — the backend is in preparation, so it
 * fails loudly at hub build rather than silently falling back; anything
 * else is the Box (incomplete, ADR 0008).
 */
const provisionerFor = (env: DeploymentEnv) =>
  Match.value(varOrDefault(env, "SAKU_ENV_PROVISIONER", "box")).pipe(
    Match.when("static", () => Effect.succeed(staticProvisioner(env))),
    Match.when("freestyle", () =>
      Effect.fail(
        new HubError({
          kind: "provisioner",
          message: "freestyle provisioner is not implemented yet — see ADR 0008",
        }),
      ),
    ),
    Match.orElse(() => Effect.succeed(boxProvisioner(env))),
  );

/**
 * The `/push` contract lives in one place (do-protocol.ts): the payload
 * schemas, the envelope helpers, and the decoders both DOs share.
 */

export class SakuHubDO {
  private hubPromise: Promise<HubShape> | undefined;
  private wire: WireCoreShape | undefined;
  private relay: HubRelayCoreShape | undefined;
  /** Accepted sockets by workerd `WebSocket` (webSocketMessage routing). */
  private readonly sockets = new Map<WebSocket, SocketLike>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: DeploymentEnv,
  ) {}

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
  private buildHubShape() {
    const state = this.state;
    const env = this.env;
    const idleStop = threadIdleStop(env);
    const idleStopMs = Number.parseInt(
      varOrDefault(env, "SAKU_IDLE_STOP_MS", String(IDLE_STOP_DEFAULT_MS)),
      10,
    );
    return Effect.fn("buildHubShape")(function* () {
      return yield* Hub.make({
        registry: yield* HubRegistry.make(),
        skills: yield* SkillsStore.make(),
        workerRef: threadWorkerRef(env),
        provisioner: yield* provisionerFor(env),
        idleStopMs,
        idleStop,
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
  private hubShape() {
    if (this.hubPromise === undefined) {
      this.hubPromise = Effect.runPromise(this.buildHubShape());
    }
    return this.hubPromise;
  }

  private async wireCore() {
    if (this.wire === undefined) {
      // A DO has no process: the hello_ok pid is 0. The runSync is safe
      // because WireCore.make performs no blocking async work (its
      // Effect.gen only builds Refs); only the hub shape above is
      // awaited, since the registry and skills store read DO storage.
      this.wire = Effect.runSync(
        WireCore.make({ hub: await this.hubShape(), token: this.env.DEPLOYMENT_SECRET, pid: 0 }),
      );
    }
    return this.wire;
  }

  private relayCore() {
    if (this.relay === undefined) {
      this.relay = Effect.runSync(HubRelayCore.make({ token: this.env.DEPLOYMENT_SECRET }));
    }
    return this.relay;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // The thread DOs' JSON channel.
    if (path === "/push" && request.method === "POST") {
      return this.handlePush(request);
    }

    // WebSocket surfaces: the wire (consoles) and the relay (daemons).
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonError("malformed", "expected a websocket upgrade");
    }
    if (path !== "/ws" && path !== "/relay") {
      return jsonError("malformed", `unknown path: ${path}`);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const socket = workerdSocket(server);
    this.sockets.set(server, socket);
    if (path === "/ws") {
      // The connection handler lives for the socket's lifetime; failures
      // are per-connection (the socket closes, the hub keeps serving).
      const core = await this.wireCore();
      void Effect.runPromise(Effect.scoped(core.runConnection(socket))).catch((error: unknown) => {
        // The DO's fetch is a plain promise boundary: fork the log.
        void Effect.runFork(Effect.logError(`[hub-do] connection failed: ${String(error)}`));
      });
    } else {
      this.relayCore().handleConnection(socket);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePush(request: Request) {
    // Malformed JSON (the tryPromise catch) and out-of-contract shapes
    // (decodeUnknownOption) both land on `none`: one error response.
    const parsed = await readBody(request, decodeHubPush);
    if (Option.isNone(parsed)) return jsonError("malformed", "malformed push");
    const push = parsed.value;
    const hub = await this.hubShape();
    return Match.value(push).pipe(
      Match.tagsExhaustive({
        report: ({ threadId, report }) => {
          hub.events.report(threadId, report);
          return jsonOk({});
        },
        sessionEvent: ({ threadId, event, tailSeq }) => {
          // The event is opaque to the hub (ADR 0005) — the same seam
          // cast the wire client applies to `EventFrame.event`.
          hub.events.sessionEvent(threadId, event as SessionWireEvent, tailSeq);
          return jsonOk({});
        },
        idleStopFired: ({ threadId }) =>
          Effect.runPromise(hub.idleStopFired(threadId))
            .then(() => jsonOk({}))
            .catch((error: unknown) => {
              const { kind, message } = rpcErrorOf(error);
              return jsonError(kind, message);
            }),
      }),
    );
  }
}
