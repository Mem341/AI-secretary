import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, ".vercel/**"],
    // PGlite boots a WASM Postgres per test file.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
