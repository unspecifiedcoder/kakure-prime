import { defineConfig } from "tsup";

// Mirrors the reference EVM implementation's wallets package' entry-point split: the base barrel (`.`) never pulls the
// FROST/TSS/threshold/solana surface; `./frost`, `./tss`, `./threshold`, `./solana` and `./tx` are opt-in.
// `./unsafe-sim` bundles the simulated ceremony drivers for cross-package tests only.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "frost/index": "src/frost/index.ts",
    "tss/index": "src/tss/index.ts",
    "threshold/index": "src/threshold/index.ts",
    "solana/index": "src/solana/index.ts",
    "unsafe-sim/index": "src/unsafe-sim/index.ts",
    "tx/index": "src/tx/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
});
