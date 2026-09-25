import { defineConfig } from "vite";

// Minimal static bench page for the browser-proving spike (workstream J). No
// framework needed -- it just loads the Go/wasm prover, fetches the circuit
// artifacts, and reports timing/memory back to the Playwright harness via
// window.__kakureBenchResult.
export default defineConfig({
  build: { outDir: "dist" },
  server: { fs: { allow: [".."] } },
});
