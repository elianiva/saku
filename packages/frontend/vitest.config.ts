import { defineConfig } from "vitest/config";

const here = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@saku/wire": `${here}/../wire/src/index.ts`,
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        inline: ["foldkit"],
      },
    },
  },
});
