import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "dist/**",
      ".turbo/**",
      ".references/**",
      "node_modules/**",
      ".wrangler/**",
      "packages/deploy/src/generated/**",
      "tools/oxlint/anti-slop/**",
    ],
    indentWidth: 2,
    lineWidth: 100,
    semi: true,
    singleQuote: false,
    sortPackageJson: true,
  },
  lint: {
    // dmmulroy/anti-slop: low-evidence TypeScript patterns.
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "./tools/oxlint/anti-slop/index.ts",
      },
    ],
    ignorePatterns: [
      "dist/**",
      ".turbo/**",
      ".references/**",
      "node_modules/**",
      ".wrangler/**",
      "tools/oxlint/anti-slop/**",
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
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  staged: {
    "*": "vp check --fix",
  },
});
