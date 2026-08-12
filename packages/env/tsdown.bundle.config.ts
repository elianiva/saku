/**
 * The Box bundle (tsdown.bundle.config.ts): the env daemon as one
 * self-contained file, uploaded into a Box by the hub's provisioner
 * (ADR 0003) — `dist/entry.bundle.js`. The Box has no node_modules and no
 * workspace, so everything (effect, ws, the tool engine) is inlined; the
 * systemd unit runs `node entry.bundle.js` with zero external deps.
 *
 * The regular `tsdown` build (package.json `build`) keeps producing the
 * package's per-module dist; this config is the deploy artifact.
 */

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/entry.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  noSplitting: true,
  clean: false,
  outExtension: () => ({ js: ".bundle.js" }),
  sourcemap: false,
});
