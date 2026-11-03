import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    // packages/policy/test/readme-snippet.ts imports the package by its published name. Its own vitest config maps
    // that to src/; the root run (pnpm gate on the server) must too, or the import resolves through package.json
    // exports to dist/, which is git-ignored and never built on the server (the 2026-11-03 00:00 buy was skipped by this).
    alias: { "@paidfor/x402-policy": fileURLToPath(new URL("./packages/policy/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "tools/**/*.test.ts", "test/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
