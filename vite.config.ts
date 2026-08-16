import { defineConfig } from "vite-plus";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "dist/**",
      ".turbo/**",
      ".references/**",
      "node_modules/**",
      ".wrangler/**",
      "packages/deploy/src/generated/**",
    ],
    indentWidth: 2,
    lineWidth: 100,
    semi: true,
    singleQuote: false,
    sortPackageJson: true,
  },
  lint: {
    // Ultracite's strict oxlint baseline, plus dmmulroy/anti-slop's
    // low-evidence rules (bundled as ultracite's anti-slop preset).
    extends: [core, antiSlop],
    ignorePatterns: [
      "dist/**",
      ".turbo/**",
      ".references/**",
      "node_modules/**",
      ".wrangler/**",
      // Stray untracked copy of the repo, not part of the workspace.
      "nwwqtzlu/**",
    ],
    options: {
      typeAware: true,
      // Oxlint's experimental type-check emits false positives on
      // effect-machine's generic `.on` overload chains (TS2769 where tsc
      // passes). Type checking stays authoritative via tsc, which `pnpm
      // typecheck` (and CI) runs separately.
      typeCheck: false,
    },
    overrides: [
      {
        env: { node: true },
        files: ["packages/{wire,worker,cli,hub,store,deploy}/**"],
      },
      {
        // The frontend runs in the browser; its vite config runs in node.
        env: { browser: true },
        files: ["packages/frontend/**"],
      },
      {
        // Process entries log to a file the CLI/systemd captures; the
        // worker daemon is grandfathered under the node env block. The
        // frontend's vite config legitimately reads the node environment.
        env: { node: true },
        files: [
          "packages/cli/**",
          "packages/env/src/entry.ts",
          "packages/worker/src/daemon.ts",
          "packages/deploy/scripts/**",
          "packages/frontend/vite.config.ts",
        ],
        rules: {
          "no-console": "off",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.spec.ts"],
        plugins: ["typescript"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off",
        },
      },
    ],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  staged: {
    "*": "vp check --fix",
  },
});
