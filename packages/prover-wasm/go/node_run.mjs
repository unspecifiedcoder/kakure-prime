// Node-side harness (task step 2): load the Go/wasm prover under Node's
// `wasm_exec.js` runtime and prove a real circuit, to validate correctness
// before ever touching a browser. Usage:
//   node node_run.mjs <acirJsonPath> <witnessGzPath> <ccsPath> <pkPath> <label>
import { readFileSync } from "node:fs";
import os from "node:os";
import "./wasm_exec.js";

const [acirPath, witnessPath, ccsPath, pkPath, label] = process.argv.slice(2);

const go = new Go();
const wasmBytes = readFileSync(new URL("./prover.wasm", import.meta.url));

const t0compile = performance.now();
const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
const t1compile = performance.now();

// go.run() blocks (via the Go program's `select {}`) until the wasm program
// exits, so it must not be awaited here -- run it in the background and poll
// for the readiness flag main() sets once kakureProve is registered.
const runPromise = go.run(instance);
runPromise.catch((err) => {
  console.error("go.run() failed:", err);
  process.exit(1);
});
while (!globalThis.kakureProveReady) {
  await new Promise((r) => setTimeout(r, 5));
}

const acirJson = readFileSync(acirPath, "utf-8");
const witnessGz = new Uint8Array(readFileSync(witnessPath));

const t0load = performance.now();
const ccsBytes = new Uint8Array(readFileSync(ccsPath));
const pkBytes = new Uint8Array(readFileSync(pkPath));
const t1load = performance.now();

const memBefore = process.memoryUsage();
const t0prove = performance.now();
const { proof, pw } = await globalThis.kakureProve(acirJson, witnessGz, ccsBytes, pkBytes);
const t1prove = performance.now();
const memAfter = process.memoryUsage();

console.log(
  JSON.stringify(
    {
      label,
      wasmCompileMs: +(t1compile - t0compile).toFixed(1),
      artifactLoadMs: +(t1load - t0load).toFixed(1),
      proveMs: +(t1prove - t0prove).toFixed(1),
      proofLen: proof.length,
      pwLen: pw.length,
      rssBeforeMB: +(memBefore.rss / 1e6).toFixed(1),
      rssAfterMB: +(memAfter.rss / 1e6).toFixed(1),
      pkSizeMB: +(pkBytes.length / 1e6).toFixed(2),
      ccsSizeMB: +(ccsBytes.length / 1e6).toFixed(2),
      hostLoadavg: os.loadavg(),
      hostFreeMemMB: +(os.freemem() / 1e6).toFixed(1),
    },
    null,
    2,
  ),
);

// Write proof/pw out for cross-verification with `sunspot verify` / decode.ts.
const outDir = new URL("./", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL(`./${label}.wasm.proof`, outDir), Buffer.from(proof));
writeFileSync(new URL(`./${label}.wasm.pw`, outDir), Buffer.from(pw));

process.exit(0);
