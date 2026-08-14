import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@saku/wire": `${here}../wire/src/index.ts`,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    server: {
      deps: {
        inline: ["foldkit"],
      },
    },
  },
});
