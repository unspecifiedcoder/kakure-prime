import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 60000,
    // The dev sandbox runs every workstream's tests concurrently and is memory-constrained; a full worker
    // pool here has hit ENOMEM crashing the whole run. One worker is slower but reliable.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
