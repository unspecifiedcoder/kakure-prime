import { defineConfig } from "vitest/config";

// Sunspot proving is a multi-minute, CPU-heavy subprocess; the RAM-constrained shared sandbox
// runs vitest with a small fork pool and generous timeouts (see justfile / package.json test script).
export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 600_000,
    testTimeout: 600_000,
  },
});
