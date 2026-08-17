/**
 * The remote env bundle (tsdown.bundle.config.ts): the env daemon as one
 * self-contained file, uploaded into a remote machine by its provider
 * provisioner (ADR 0003). The machine has no node_modules and no workspace,
 * so everything (effect, ws, the tool engine) is inlined; the
 * systemd unit runs `node entry.bundle.js` with zero external deps.
 *
 * The regular `tsdown` build (package.json `build`) keeps producing the
 * package's per-module dist; this config is the deploy artifact.
 */

import { defineConfig } from "tsdown";

export default defineConfig({
  clean: false,
  entry: ["src/entry.ts"],
  format: "esm",
  outDir: "dist",
  outExtensions: () => ({ js: ".bundle.js" }),
  platform: "node",
  sourcemap: false,
});
