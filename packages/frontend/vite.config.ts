/**
 * The frontend's vite config: the foldkit HMR plugin (state-preserving),
 * tailwind, and the dev bootstrap — a `/__saku` endpoint that surfaces the
 * local worker daemon's published URL and token (`~/.saku/worker.url` +
 * `~/.saku/auth`), so the console connects straight to the daemon. The app
 * fetches it at boot and falls back to same-origin `/ws` (the deployed hub,
 * ADR 0002) when the endpoint is absent.
 *
 * The bootstrap verifies before publishing: it probes the published URL
 * with a real wire handshake, and only hands the endpoint out when the
 * daemon answers. A killed daemon leaves a stale `worker.url` behind, and
 * the console must never dial a dead socket — `{url: null}` is the
 * daemon-offline marker the frontend shows (and polls until the daemon
 * returns).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { WireClient } from "@saku/wire";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const readMaybe = (path: string) =>
  readFile(path, "utf8")
    .then((content) => content.trim())
    .catch(() => null);

/**
 * Whether the daemon answers the wire handshake at the endpoint (the same
 * probe the CLI's lifecycle uses: hello_ok proves the URL and token are
 * both current). Refused or timed out means offline.
 */
const probeDaemon = (url: string, token: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* WireClient.make({
        url,
        token,
        role: "cli",
        requestTimeoutMs: 1500,
      });
      const alive = yield* client
        .connect()
        .pipe(
          Effect.timeout("1.5 seconds"),
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
      yield* client.disconnect();
      return alive;
    }),
  );

const sakuDevBootstrap = () => ({
  name: "saku-dev-bootstrap",
  configureServer(server) {
    server.middlewares.use("/__saku", (_request, response) => {
      const sakuHome = process.env.SAKU_HOME ?? join(homedir(), ".saku");
      void Promise.all([
        readMaybe(join(sakuHome, "worker.url")),
        readMaybe(join(sakuHome, "auth")),
      ]).then(([url, token]) => {
        response.setHeader("content-type", "application/json");
        const live =
          url !== null && token !== null ? probeDaemon(url, token) : Promise.resolve(false);
        void live.then((isLive) => {
          response.end(JSON.stringify(isLive ? { url, token } : { url: null, token: null }));
        });
      });
    });
  },
});

export default defineConfig({
  plugins: [foldkit(), tailwindcss(), sakuDevBootstrap()],
  server: {
    // Portless (the `dev` script's proxy) assigns a free 4000-4999 port and
    // passes it as PORT; without it, the plain `dev:app` fallback stays on
    // 5173. strictPort turns a taken port into a loud startup failure while
    // portless drives — silent drift would break the stable URL the proxy
    // registered.
    port: Number(process.env.PORT ?? 5173),
    strictPort: process.env.PORT !== undefined,
  },
});
