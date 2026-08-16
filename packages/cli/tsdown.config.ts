import { defineConfig } from "tsdown";

export default defineConfig({
  dts: false,
  entry: ["src/index.ts", "src/entry.ts"],
  fixedExtension: false,
  format: "esm",
});
