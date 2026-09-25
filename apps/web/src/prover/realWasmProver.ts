/**
 * The real browser wasm prover (`@kakure/prover-wasm`, merged to main at `b00ffa3`). Used for
 * `CircuitId.Deposit`/`Withdraw` (personal deposits, the recipient claim page's withdraw) per
 * `router.ts`'s routing policy -- never for `transfer_multisig`.
 *
 * Everything here is loaded LAZILY: the wasm binary is ~20 MB and each circuit's proving key is
 * multiple MB, so nothing in this file is imported/fetched until the first `prove()`/
 * `capabilities()` call actually happens on the claim or deposit route -- never on `/`,
 * `/treasury/:id`'s other tabs, or `/audit`.
 *
 * Runs in a dedicated Web Worker (`wasmProverPort({ worker: true })`): the prove pipeline is
 * 25-120s of CPU, and inline it would freeze the claim/deposit page. `@kakure/prover-wasm`'s own
 * default worker URL (`new URL("./worker.js", import.meta.url)`) resolves relative to the
 * package's `dist/` and does not survive Vite's production bundle, so the worker script is
 * imported here with Vite's `?worker&url` suffix -- Vite emits `dist/worker.js` as its own chunk
 * and hands back the URL to pass as `workerUrl`. In worker mode the worker loads Go's `wasm_exec.js`
 * glue itself (bundled into `dist/worker.js`); nothing is injected into the page.
 */
import { CircuitId, type ProverPort } from "@kakure/sdk/tx";

export type WasmProgressStage = "loading-pk" | "witness" | "proving";
export type WasmProgressListener = (event: { circuit: CircuitId; stage: WasmProgressStage }) => void;

const CIRCUIT_ASSET_BASE = "/prover-wasm/circuits";
const WASM_URL = "/prover-wasm/prover.wasm";

function circuitAssetName(circuit: CircuitId): "deposit" | "withdraw" {
  if (circuit === CircuitId.Deposit) return "deposit";
  if (circuit === CircuitId.Withdraw) return "withdraw";
  throw new Error(`realWasmProver: no wasm artifacts shipped for circuit ${circuit}`);
}

let wasmBytesPromise: Promise<ArrayBuffer> | undefined;

function fetchWasmBytes(): Promise<ArrayBuffer> {
  wasmBytesPromise ??= fetch(WASM_URL).then((res) => {
    if (!res.ok) throw new Error(`failed to fetch ${WASM_URL}: ${res.status}`);
    return res.arrayBuffer();
  });
  return wasmBytesPromise;
}

const artifactCache = new Map<string, Promise<{ acirJson: string; ccsBytes: Uint8Array; pkBytes: Uint8Array }>>();

async function fetchArtifacts(circuit: CircuitId): Promise<{ acirJson: string; ccsBytes: Uint8Array; pkBytes: Uint8Array }> {
  const name = circuitAssetName(circuit);
  let pending = artifactCache.get(name);
  if (!pending) {
    pending = (async () => {
      const [acirJson, ccsBytes, pkBytes] = await Promise.all([
        fetch(`${CIRCUIT_ASSET_BASE}/${name}.json`).then((r) => r.text()),
        fetch(`${CIRCUIT_ASSET_BASE}/${name}.ccs`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
        fetch(`${CIRCUIT_ASSET_BASE}/${name}.pk`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      ]);
      return { acirJson, ccsBytes, pkBytes };
    })();
    artifactCache.set(name, pending);
  }
  return pending;
}

export interface RealWasmProverOptions {
  onProgress?: WasmProgressListener;
  /** Test seam: skips the Worker and proves inline (jsdom has no `Worker`). */
  inline?: boolean;
}

let workerUrlPromise: Promise<string> | undefined;

/** Vite: `?worker&url` bundles the dependency's worker entry as a separate chunk and resolves to
 *  its served URL (in dev, the transformed module URL). Cached: one chunk load per page. */
function workerScriptUrl(): Promise<string> {
  workerUrlPromise ??= import("@kakure/prover-wasm/worker?worker&url").then((m) => m.default);
  return workerUrlPromise;
}

/** Builds the real `ProverPort` over `@kakure/prover-wasm`, lazily importing the package itself
 *  (code-split by the bundler, per this file's own doc comment) on first use. */
export function realWasmProver(opts: RealWasmProverOptions = {}): ProverPort {
  return {
    async capabilities() {
      return { circuits: [CircuitId.Deposit, CircuitId.Withdraw], environment: "wasm" as const };
    },
    async prove(circuit, inputs) {
      const { wasmProverPort } = await import("@kakure/prover-wasm");
      opts.onProgress?.({ circuit, stage: "loading-pk" });
      const [wasmBytes, workerUrl] = await Promise.all([fetchWasmBytes(), opts.inline ? undefined : workerScriptUrl()]);
      const port = wasmProverPort({
        wasmBytes,
        circuits: [CircuitId.Deposit, CircuitId.Withdraw],
        artifactsFor: fetchArtifacts,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.inline ? {} : { worker: true, workerUrl: workerUrl! }),
      });
      return port.prove(circuit, inputs);
    },
  };
}
