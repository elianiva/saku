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
 * provisioner (or the static one, `SAKU_ENV_PROVISIONER=static`); the
 * idle-stop window is armed in the thread DOs as durable alarms (the
 * hub's `IdleStopController`), and the fire path runs here.
 */

import { Effect } from "effect";
import {
  makeHub,
  makeHubRegistry,
  makeHubRelayCore,
  makeSkillsStore,
  makeProvisioner,
  makeWireCore,
  makeBoxApi,
  workerdSocket,
  type HubShape,
  type HubRelayCoreShape,
  type SocketLike,
  type WireCoreShape,
} from "@saku/hub/core";

import { doStorageKv } from "./kv.ts";
import { varOrDefault, type DeploymentEnv } from "./env.ts";
import { threadIdleStop, threadWorkerRef, type HubPush } from "./rpc.ts";
import { staticProvisioner } from "./static-provisioner.ts";
import { ENV_BUNDLE_BASE64 } from "./generated/env-bundle.ts";

export const IDLE_STOP_DEFAULT_MS = 300_000;

/** The Box provisioner with the deployment's key and embedded bundle. */
const boxProvisioner = (env: DeploymentEnv) =>
  makeProvisioner({
    boxApi: makeBoxApi({ apiKey: env.BOX_API_KEY }),
    // The env daemon bundle is embedded at build time (scripts/
    // embed-env-bundle.ts): a DO cannot read the filesystem.
    readBundle: () =>
      Effect.gen(function* () {
        const binary = atob(ENV_BUNDLE_BASE64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }),
    log: (message) => console.error(`[hub-do] box: ${message}`),
  });

/**
 * The deployment's provisioner: `SAKU_ENV_PROVISIONER=static` opts into
 * the configured-daemon mode (dev/celld); anything else is the Box.
 */
const provisionerFor = (env: DeploymentEnv) =>
  varOrDefault(env, "SAKU_ENV_PROVISIONER", "box") === "static"
    ? staticProvisioner(env)
    : boxProvisioner(env);

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
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.sockets.get(ws)?.receive?.(message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const socket = this.sockets.get(ws);
    this.sockets.delete(ws);
    socket?.receiveClose?.(code, reason);
  }
  /** The hub core over DO storage, built once per activation (async: the
   * registry and skills store read DO storage at construction). */
  private hubShape(): Promise<HubShape> {
    if (this.hubPromise === undefined) {
      const state = this.state;
      const env = this.env;
      const idleStop = threadIdleStop(env);
      const idleStopMs = Number.parseInt(
        varOrDefault(env, "SAKU_IDLE_STOP_MS", String(IDLE_STOP_DEFAULT_MS)),
        10,
      );
      this.hubPromise = Effect.runPromise(
        Effect.gen(function* () {
          const kv = doStorageKv(state.storage);
          return yield* makeHub({
            registry: yield* makeHubRegistry(kv),
            skills: yield* makeSkillsStore(kv),
            workerRef: threadWorkerRef(env),
            provisioner: provisionerFor(env),
            idleStopMs,
            idleStop,
          });
        }),
      );
    }
    return this.hubPromise;
  }

  private async wireCore(): Promise<WireCoreShape> {
    if (this.wire === undefined) {
      // A DO has no process: the hello_ok pid is 0.
      this.wire = Effect.runSync(
        makeWireCore({ hub: await this.hubShape(), token: this.env.DEPLOYMENT_SECRET, pid: 0 }),
      );
    }
    return this.wire;
  }

  private relayCore(): HubRelayCoreShape {
    if (this.relay === undefined) {
      this.relay = Effect.runSync(makeHubRelayCore({ token: this.env.DEPLOYMENT_SECRET }));
    }
    return this.relay;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The thread DOs' JSON channel.
    if (path === "/push" && request.method === "POST") {
      return this.handlePush(request);
    }

    // WebSocket surfaces: the wire (consoles) and the relay (daemons).
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonError("expected a websocket upgrade");
    }
    if (path !== "/ws" && path !== "/relay") {
      return jsonError(`unknown path: ${path}`);
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
      void Effect.runPromise(Effect.scoped(core.runConnection(socket))).catch(
        (error: unknown) => {
          console.error(`[hub-do] connection failed: ${String(error)}`);
        },
      );
    } else {
      this.relayCore().handleConnection(socket);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePush(request: Request): Promise<Response> {
    let push: HubPush;
    try {
      push = (await request.json()) as HubPush;
    } catch {
      return jsonError("malformed push");
    }
    const hub = await this.hubShape();
    switch (push.type) {
      case "report":
        hub.events.report(push.threadId, push.report);
        return jsonOk({});
      case "sessionEvent":
        hub.events.sessionEvent(push.threadId, push.event, push.tailSeq);
        return jsonOk({});
      case "idleStopFired":
        return Effect.runPromise(hub.idleStopFired(push.threadId))
          .then(() => jsonOk({}))
          .catch((error: unknown) => jsonError(String(error)));
      default:
        return jsonError(`unknown push type`);
    }
  }
}

const jsonOk = (payload: unknown): Response =>
  Response.json({ ok: true, payload });

const jsonError = (error: string): Response =>
  Response.json({ ok: false, error }, { status: 400 });
