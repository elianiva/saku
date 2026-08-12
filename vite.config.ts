import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", ".turbo/**", ".references/**", "node_modules/**", ".wrangler/**"],
    singleQuote: false,
    semi: true,
    indentWidth: 2,
    lineWidth: 100,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: ["dist/**", ".turbo/**", ".references/**", "node_modules/**", ".wrangler/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
    overrides: [
      {
        files: ["packages/{wire,worker,cli,hub,store,deploy}/**"],
        env: { node: true },
      },
      {
        // The frontend runs in the browser; its vite config runs in node.
        files: ["packages/frontend/**"],
        env: { browser: true },
      },
      {
        // Process entries log to a file the CLI/systemd captures; the
        // worker daemon is grandfathered under the node env block. The
        // frontend's vite config legitimately reads the node environment.
        files: [
          "packages/cli/**",
          "packages/env/src/entry.ts",
          "packages/deploy/scripts/**",
          "packages/frontend/vite.config.ts",
        ],
        env: { node: true },
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
  },
  staged: {
    "*": "vp check --fix",
  },
});
