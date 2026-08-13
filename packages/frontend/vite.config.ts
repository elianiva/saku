/**
 * The frontend's vite config: the foldkit HMR plugin (state-preserving),
 * tailwind, and the dev bootstrap — a `/__saku` endpoint that surfaces the
 * local worker daemon's published URL and token (`~/.saku/worker.url` +
 * `~/.saku/auth`), so the console connects straight to the daemon. The app
 * fetches it at boot and falls back to same-origin `/ws` (the deployed hub,
 * ADR 0002) when the endpoint is absent.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const readMaybe = (path: string): Promise<string | null> =>
  readFile(path, "utf8")
    .then((content) => content.trim())
    .catch(() => null);

const sakuDevBootstrap = (): Plugin => ({
  name: "saku-dev-bootstrap",
  configureServer(server) {
    server.middlewares.use("/__saku", (_request, response) => {
      const sakuHome = process.env.SAKU_HOME ?? join(homedir(), ".saku");
      void Promise.all([
        readMaybe(join(sakuHome, "worker.url")),
        readMaybe(join(sakuHome, "auth")),
      ]).then(([url, token]) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ url, token }));
      });
    });
  },
});

export default defineConfig({
  plugins: [foldkit(), tailwindcss(), sakuDevBootstrap()],
  server: { port: 5173 },
});
