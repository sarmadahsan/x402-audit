import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  // The developer already has @x402/core (peer dependency); nothing else is bundled.
  external: ["@x402/core", "@x402/core/client", "@x402/core/http", "@x402/core/types", "node:crypto"],
});
