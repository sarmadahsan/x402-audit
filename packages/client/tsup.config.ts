import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  dts: { resolve: [/^x402-audit/] },
  clean: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  // The root package ships TypeScript source; inline it so the published artifact is self-contained.
  noExternal: ["x402-audit"],
  external: ["node:crypto", "ajv", "ajv-formats", "jsonpath-plus"],
});
