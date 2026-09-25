import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // See apps/dashboard's identical note (before it was deleted, superseded by this app): @kakure/sdk
  // transitively pulls in @aztec/foundation, which does `import { inspect } from "util"` purely to
  // attach a Node console-formatting symbol to a secret-wrapper class. Vite's default production
  // build externalizes Node built-ins to an empty stub with no exports, so that NAMED import fails
  // `vite build` with a Rollup "is not exported by __vite-browser-external" error (dev mode/vitest
  // don't hit this). `src/shims/util-browser-shim.ts` is a safe no-op substitute in a browser bundle.
  // `@kakure/cli`'s `buildTransferMultisigInputsFromProposal` (used by `treasuryFlows.ts`) imports
  // a pure function from `@kakure/prover`, but that package's single entry point also drags in its
  // Node-only proving code (`path`/`fs`/`fs/promises`/`child_process`/`os`, never called from the
  // browser -- proving always goes through the Kakure Helper's HTTP API here). See
  // `src/shims/node-noop-shim.ts`'s doc comment for the full explanation.
  resolve: {
    // Vite's plain-object `alias` matches by prefix in insertion order (so a shorter key like
    // "fs" would otherwise swallow "fs/promises" too) -- the array form with `exact: true` avoids
    // that entirely, one entry per real specifier.
    alias: [
      { find: "util", replacement: fileURLToPath(new URL("./src/shims/util-browser-shim.ts", import.meta.url)) },
      { find: "path", replacement: fileURLToPath(new URL("./src/shims/node-noop-shim.ts", import.meta.url)) },
      { find: "fs/promises", replacement: fileURLToPath(new URL("./src/shims/node-noop-shim.ts", import.meta.url)) },
      { find: "fs", replacement: fileURLToPath(new URL("./src/shims/node-noop-shim.ts", import.meta.url)) },
      { find: "child_process", replacement: fileURLToPath(new URL("./src/shims/node-noop-shim.ts", import.meta.url)) },
      { find: "os", replacement: fileURLToPath(new URL("./src/shims/node-noop-shim.ts", import.meta.url)) },
    ],
  },
  // NOTE: `@kakure/cli`'s proposal/coordinator modules also reference the Node global `Buffer`.
  // `vite-plugin-node-polyfills` (the usual fix) scans EVERY module's AST for `Buffer` usage and
  // injects an import into each one it finds, including already-built `dist/` output of workspace
  // packages like `@kakure/sdk` -- Rollup can't resolve the plugin's injected shim import there,
  // failing the whole build. Fixed instead with a single explicit polyfill assignment at the very
  // top of `src/main.tsx` (`globalThis.Buffer = require("buffer").Buffer`), before anything else
  // in the app (including its indirect imports of those `@kakure/cli` modules) runs.
  build: {
    outDir: "dist",
  },
  // `@kakure/prover-wasm/worker?worker&url` (src/prover/realWasmProver.ts): the prover's Web
  // Worker is a module worker with its own imports, so it must be emitted as an ES chunk (Vite's
  // default `iife` worker format cannot code-split).
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/setupTests.ts"],
    // This sandbox is RAM-constrained and shared with other agents' vitest/tsc runs; the crypto-heavy
    // scan/DKG/keystore tests (Poseidon2/BJJ ops, scrypt) can take much longer than vitest's 5s
    // default under that pressure.
    testTimeout: 60000,
    hookTimeout: 60000,
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
