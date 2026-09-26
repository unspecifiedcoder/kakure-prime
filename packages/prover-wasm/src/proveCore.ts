/**
 * The prove logic shared by `wasmProver.ts`'s inline (main-thread) path and `worker.ts`'s Web
 * Worker path -- everything from "have the four `kakureProve` inputs" to "have a `ProofBundle`".
 * Kept separate so it can be imported into two different bundles (the main library entry and the
 * worker entry) without duplicating the decode/compress/witness-execution logic.
 */
import { type CompiledCircuit } from "@noir-lang/noir_js";
import { executeWitness, decodePublicWitness, compressProof, circuitNameFor } from "@kakure/prover";
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle } from "@kakure/sdk/tx";

/** The Go wasm module's exported entry point, once instantiated (`js.Global().Set("kakureProve", ...)`
 * in `go/main.go`). Returns the RAW (uncompressed) Sunspot `.proof`/`.pw` bytes. */
export type KakureProveFn = (
  acirJson: string,
  witnessGz: Uint8Array,
  ccsBytes: Uint8Array,
  pkBytes: Uint8Array,
) => Promise<{ proof: Uint8Array; pw: Uint8Array }>;

/** Coarse progress stages -- this is a Groth16 prover with no fine-grained internal progress
 * hooks, so these are the only two CPU-bound phases worth reporting: building the Noir witness
 * (fast, <1s even for `transfer_multisig`) and the Groth16 prove itself (the slow part, see
 * README). A third stage, "loading-pk", is reported by the CALLER right before it fetches
 * artifacts (see `wasmProver.ts`) since that's I/O, not part of this function. */
export type ProveCoreStage = "witness" | "proving";

export interface RunProveCoreArgs {
  readonly circuit: CircuitId;
  readonly inputs: Record<string, unknown>;
  readonly acirJson: string;
  readonly ccsBytes: Uint8Array;
  readonly pkBytes: Uint8Array;
  readonly kakureProve: KakureProveFn;
  onProgress?(stage: ProveCoreStage): void;
}

export async function runProveCore(args: RunProveCoreArgs): Promise<ProofBundle> {
  const circuitName = circuitNameFor(args.circuit);
  const compiled = JSON.parse(args.acirJson) as CompiledCircuit;

  args.onProgress?.("witness");
  // ALWAYS LOCAL: the witness (which carries the caller's spend scalar) is built and consumed
  // entirely in this realm (main thread or worker) and never leaves it.
  const witnessGz = await executeWitness(circuitName, compiled, args.inputs as never);

  args.onProgress?.("proving");
  const { proof: rawProof, pw } = await args.kakureProve(args.acirJson, witnessGz, args.ccsBytes, args.pkBytes);

  const publicInputs = decodePublicWitness(pw);
  const expected = PUBLIC_INPUT_COUNT[args.circuit];
  if (publicInputs.length !== expected) {
    throw new Error(
      `wasmProverPort: circuit ${circuitName} expected ${expected} public inputs, wasm prover produced ${publicInputs.length}`,
    );
  }

  // compressProof validates and decodes the raw proof; avoid doing the identical parse twice.
  const compressedProof = compressProof({ proof: rawProof, publicInputs });
  return { circuitId: args.circuit, proof: compressedProof, publicInputs };
}

/** Instantiates the wasm module in the current JS realm (main thread or worker) and waits for
 * `go/main.go`'s `main()` to register `kakureProve` on `globalThis`. Idempotent per realm -- call
 * it once; `globalThis.kakureProve` is then usable directly. */
export async function instantiateWasm(
  wasmBytes: BufferSource,
  goCtor?: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> },
): Promise<void> {
  const GoCtor = goCtor ?? (globalThis as unknown as { Go?: typeof goCtor }).Go;
  if (!GoCtor) {
    throw new Error(
      "prover-wasm: no global `Go` constructor found -- load Go's wasm_exec.js glue " +
        "(packages/prover-wasm/go/wasm_exec.js) before instantiating the wasm module.",
    );
  }
  const go = new GoCtor();
  const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
  // go.run() only resolves when the wasm program exits (main.go's `select {}` never returns), so
  // it must run in the background -- poll the readiness flag main() sets right after registering
  // `kakureProve` on globalThis.
  go.run(instance).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("prover-wasm: go.run() exited unexpectedly", err);
  });
  while (!(globalThis as unknown as { kakureProveReady?: boolean }).kakureProveReady) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
