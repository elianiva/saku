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

import { homedir } from "node:os";
import path from "node:path";

import { Effect, FileSystem } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { WireClient } from "@saku/wire";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";

const readMaybe = async (filePath: string) => {
  const content = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(filePath);
    }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.catch(() => Effect.succeed("")),
    ),
  );
  return content.length > 0 ? content.trim() : null;
};

/**
 * Whether the daemon answers the wire handshake at the endpoint (the same
 * probe the CLI's lifecycle uses: hello_ok proves the URL and token are
 * both current). Refused or timed out means offline.
 */
const probeDaemon = async (url: string, token: string) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* WireClient.make({
        requestTimeoutMs: 1500,
        role: "cli",
        token,
        url,
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
  configureServer(server: {
    middlewares: {
      use: (
        path: string,
        handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
      ) => void;
    };
  }) {
    server.middlewares.use("/__saku", async (_request, response) => {
      const sakuHome = process.env.SAKU_HOME ?? path.join(homedir(), ".saku");
      const [url, token] = await Promise.all([
        readMaybe(path.join(sakuHome, "worker.url")),
        readMaybe(path.join(sakuHome, "auth")),
      ]);
      response.setHeader("content-type", "application/json");
      const isLive = url !== null && token !== null ? await probeDaemon(url, token) : false;
      response.end(JSON.stringify(isLive ? { token, url } : { token: null, url: null }));
    });
  },
  name: "saku-dev-bootstrap",
});

export default defineConfig({
  plugins: [foldkit(), tailwindcss(), sakuDevBootstrap()],
});
