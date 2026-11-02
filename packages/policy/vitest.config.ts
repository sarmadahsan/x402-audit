import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // So test/readme-snippet.ts can import the package by its published name.
    alias: { "@paidfor/x402-policy": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
