import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  dts: false,
  format: "esm",
  fixedExtension: false,
});
