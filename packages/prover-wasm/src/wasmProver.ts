/**
 * `WasmProver`: a `ProverPort` (sdk `tx/ports.ts`) implementation over the Go/gnark Groth16 prover
 * compiled to WebAssembly (`packages/prover-wasm/go`, `GOOS=js GOARCH=wasm`), for §3A of the
 * customer-app design (browser proving, no server). This mirrors `@kakure/prover`'s native
 * `prove()` pipeline (`noir_js` witness -> Sunspot's Groth16 prove -> decode -> compress) exactly,
 * with the "Sunspot Groth16 prove" step done by the wasm module's exported `kakureProve` instead
 * of shelling out to the `sunspot` CLI. See `proveCore.ts` for the shared logic and `worker.ts` for
 * the Web Worker variant this file drives when `{ worker: true }`.
 *
 * WORKSTREAM J SPIKE VERDICT (see this package's README.md for the full numbers): correctness is
 * exact -- the wasm module's `.proof`/`.pw` bytes are byte-for-byte in Sunspot's own wire format
 * and verify with `sunspot verify` and this package's `decodePublicWitness`/`decodeProof`. Timing
 * is the blocker: `groth16.Prove`'s FFT/MSM steps parallelize across cores natively (gnark uses
 * goroutines over real OS threads), but `GOOS=js GOARCH=wasm` has no OS threads, so the wasm build
 * runs those steps on a single core. `deposit`/`withdraw`-sized circuits clear the design doc's
 * <90s bar with margin; `transfer_multisig` sits at/over it under this spike's (loaded) hardware.
 * Treat `transfer_multisig`-class circuits as validated-but-not-yet-shippable until either (a) a
 * wasm build with real multithreading (wasm threads + SharedArrayBuffer, needing a from-scratch
 * gnark MSM/FFT parallel port) closes the gap, or (b) the design doc's own §3 fallback applies
 * ("claim later on desktop" via the Helper).
 *
 * USAGE NOTE (non-worker mode): the wasm module is loaded via Go's own generated `wasm_exec.js`
 * glue (copied verbatim from `$(go env GOROOT)/lib/wasm/wasm_exec.js` into `go/wasm_exec.js`),
 * which defines a global `Go` class. The CALLER must load that script (a `<script>` tag in a
 * browser page, or a side-effect import in Node) before calling `wasmProverPort()` in non-worker
 * mode -- this package does not bundle or re-export it, so the same glue file always matches the Go
 * toolchain that built `prover.wasm`. In worker mode, `worker.ts` loads it itself inside the worker
 * realm; the main thread never needs `Go` defined.
 */
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle, type ProverPort } from "@kakure/sdk/tx";
import { instantiateWasm, runProveCore, type KakureProveFn, type ProveCoreStage } from "./proveCore.js";

/** The bytes `kakureProve` needs for one circuit, however the caller wants to fetch them. Use
 * `cachedFetchBytes` (`cache.ts`) to avoid re-downloading the (7-30MB) `.pk` on every visit. */
export interface WasmCircuitArtifacts {
  /** The circuit's compiled ACIR, as the raw JSON text (NOT pre-parsed) -- both `noir_js` (parsed
   * internally) and the Go wasm module (which decodes it itself, unparsed) need it. */
  readonly acirJson: string;
  readonly ccsBytes: Uint8Array;
  readonly pkBytes: Uint8Array;
}

/** Progress callback stages: `loading-pk` covers `artifactsFor()` (I/O: fetching/decompressing the
 * ACIR/CCS/PK, dominated in practice by the `.pk`); `witness` and `proving` are `proveCore.ts`'s
 * two CPU-bound phases (see its doc comment -- `proving` is overwhelmingly the slow one). */
export type WasmProverProgressStage = "loading-pk" | ProveCoreStage;

export interface WasmProverOptions {
  /** The `prover.wasm` binary (`packages/prover-wasm/go/prover.wasm`), already fetched/read. */
  readonly wasmBytes: BufferSource;
  /** Which circuits this deployment ships wasm artifacts for -- `capabilities()` reports exactly these. */
  readonly circuits: readonly CircuitId[];
  /** Fetches (or reads) the artifacts `kakureProve` needs for one circuit. Called once per `prove()`
   * call -- the caller is free to cache across calls (`cachedFetchBytes` does this for you). */
  artifactsFor(circuit: CircuitId): Promise<WasmCircuitArtifacts>;
  /** Override for tests: defaults to `globalThis.Go`, which Go's `wasm_exec.js` glue sets. Ignored
   * in worker mode (the worker always uses its own realm's `globalThis.Go`). */
  goCtor?: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
  /** Reports coarse progress so a UI can show "loading proving key..." / "proving..." instead of
   * an indefinite spinner for up to ~165s (see README). Called synchronously from `prove()`'s
   * caller-visible steps (worker mode: forwarded from the worker's postMessage stream). */
  onProgress?(event: { circuit: CircuitId; stage: WasmProverProgressStage }): void;
  /** Run the prove pipeline in a Web Worker instead of inline, so a `transfer_multisig`-length
   * prove call never blocks the UI thread. Defaults to `false` (inline) for Node/test use, where
   * there is no DOM event loop to protect and Workers add real complexity for no benefit. */
  worker?: boolean;
  /** Override the worker script URL (tests, or a bundler-specific asset path). Defaults to
   * `new URL("./worker.js", import.meta.url)`, which resolves correctly for consumers importing
   * this package's own `dist/worker.js` next to `dist/index.js`. Only meaningful with `worker: true`. */
  workerUrl?: string | URL;
}

/** Builds a `ProverPort` backed by the wasm prover, either inline on the calling thread or (with
 * `worker: true`) in a dedicated Web Worker. Instantiates the wasm module lazily (once, shared
 * across every `prove()` call) on the first `prove()`/`capabilities()` call. */
export function wasmProverPort(opts: WasmProverOptions): ProverPort {
  return opts.worker ? wasmProverPortViaWorker(opts) : wasmProverPortInline(opts);
}

function wasmProverPortInline(opts: WasmProverOptions): ProverPort {
  let ready: Promise<void> | undefined;

  return {
    async capabilities() {
      return { circuits: opts.circuits, environment: "wasm" as const };
    },

    async prove(circuit: CircuitId, inputs: Record<string, unknown>): Promise<ProofBundle> {
      ready ??= instantiateWasm(opts.wasmBytes, opts.goCtor);
      await ready;

      const kakureProve = (globalThis as unknown as { kakureProve?: KakureProveFn }).kakureProve;
      if (!kakureProve) {
        throw new Error("wasmProverPort: kakureProve was not registered by the wasm module");
      }

      opts.onProgress?.({ circuit, stage: "loading-pk" });
      const { acirJson, ccsBytes, pkBytes } = await opts.artifactsFor(circuit);

      return runProveCore({
        circuit,
        inputs,
        acirJson,
        ccsBytes,
        pkBytes,
        kakureProve,
        onProgress: (stage) => opts.onProgress?.({ circuit, stage }),
      });
    },
  };
}

interface PendingRequest {
  resolve(bundle: ProofBundle): void;
  reject(err: Error): void;
  circuit: CircuitId;
}

function wasmProverPortViaWorker(opts: WasmProverOptions): ProverPort {
  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  let nextRequestId = 0;
  const pending = new Map<number, PendingRequest>();

  function ensureWorker(): Promise<void> {
    ready ??= new Promise<void>((resolveReady, rejectReady) => {
      const url = opts.workerUrl ?? new URL("./worker.js", import.meta.url);
      const w = new Worker(url, { type: "module" });
      worker = w;

      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as
          | { type: "ready" }
          | { type: "progress"; requestId: number; circuit: CircuitId; stage: ProveCoreStage }
          | { type: "result"; requestId: number; proof: ArrayBuffer; publicInputs: ArrayBuffer[] }
          | { type: "error"; requestId: number; message: string };

        if (msg.type === "ready") {
          resolveReady();
          return;
        }
        if (msg.type === "progress") {
          opts.onProgress?.({ circuit: msg.circuit, stage: msg.stage });
          return;
        }
        const req = pending.get(msg.requestId);
        if (msg.type === "error") {
          if (msg.requestId === -1) {
            rejectReady(new Error(msg.message));
          } else {
            req?.reject(new Error(msg.message));
            pending.delete(msg.requestId);
          }
          return;
        }
        // msg.type === "result"
        req?.resolve({
          circuitId: req.circuit,
          proof: new Uint8Array(msg.proof),
          publicInputs: msg.publicInputs.map((buf) => new Uint8Array(buf)),
        });
        pending.delete(msg.requestId);
      };
      w.onerror = (err) => rejectReady(new Error(`prover-wasm worker failed to load: ${err.message}`));

      w.postMessage({ type: "init", wasmBytes: opts.wasmBytes });
    });
    return ready;
  }

  return {
    async capabilities() {
      return { circuits: opts.circuits, environment: "wasm" as const };
    },

    async prove(circuit: CircuitId, inputs: Record<string, unknown>): Promise<ProofBundle> {
      await ensureWorker();
      if (!worker) throw new Error("wasmProverPort: worker failed to initialize");

      opts.onProgress?.({ circuit, stage: "loading-pk" });
      const { acirJson, ccsBytes, pkBytes } = await opts.artifactsFor(circuit);

      const requestId = nextRequestId++;
      const result = new Promise<ProofBundle>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, circuit });
      });
      // Not a zero-copy transfer: `ccsBytes`/`pkBytes` are structured-cloned rather than passed in
      // a transfer list, because `artifactsFor` (e.g. `cachedFetchBytes`) may hand back a buffer
      // it intends to reuse across calls -- transferring would silently detach it. A production
      // integration that always re-fetches (or clones before caching) could transfer instead to
      // avoid copying the 7-30MB `.pk` on every call.
      worker.postMessage({ type: "prove", requestId, circuit, inputs, acirJson, ccsBytes, pkBytes });
      return result;
    },
  };
}

