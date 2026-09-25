import { defineConfig } from "@playwright/test";

/**
 * Spec §6: the payroll demo flow against a real localnet + Kakure Helper. Run in the FOREGROUND
 * with a long timeout (`just e2e-payroll`), and never alongside another `solana-test-validator` on
 * this machine -- `e2e/payroll.spec.ts`'s own `beforeAll` starts one.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 20 * 60 * 1000, // real Groth16 proving + a real 5-signer DKG, not mocked
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
});
