import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/entry.ts"],
  dts: false,
  format: "esm",
  fixedExtension: false,
});
