import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 120000,
    testTimeout: 120000,
    // The whole point of this suite: one localnet at a time, on this RAM-constrained sandbox.
    fileParallelism: false,
  },
});
