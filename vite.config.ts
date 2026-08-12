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
        files: ["packages/{wire,worker,cli,hub,store}/**"],
        env: { node: true },
      },
      {
        files: ["packages/cli/**"],
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
