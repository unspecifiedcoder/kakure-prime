/**
 * Web Worker entry point: runs the wasm prover off the main/UI thread so a long
 * `transfer_multisig`-style prove call (90-165s measured, see README.md) never freezes the page.
 * A consuming app loads this as a module worker:
 *
 *   const worker = new Worker(new URL("@kakure/prover-wasm/worker", import.meta.url), { type: "module" });
 *
 * ...but callers should generally not do that directly -- `wasmProverPort({ worker: true, ... })`
 * (`wasmProver.ts`) drives this file and speaks its message protocol for you.
 *
 * Message protocol (all messages are plain objects, structured-clone-safe -- no functions):
 *   -> {type:"init", wasmBytes: ArrayBuffer}                                  (once, before any "prove")
 *   <- {type:"ready"} | {type:"error", requestId:-1, message}
 *   -> {type:"prepare", requestId, circuit, acirJson, ccsBytes, pkBytes}       (once per circuit)
 *   <- {type:"prepared", requestId}
 *   -> {type:"prove", requestId, circuit, inputs}                            (small messages thereafter)
 *   <- {type:"progress", requestId, circuit, stage:"witness"|"proving"}       (zero or more)
 *   <- {type:"result", requestId, proof: ArrayBuffer, publicInputs: ArrayBuffer[]}
 *      | {type:"error", requestId, message}
 *
 * `wasm_exec.js` (Go's own glue) works unmodified in a Worker: it only touches `globalThis`
 * (`crypto`, `performance`, `TextEncoder`/`TextDecoder`, a `fs`/`process`/`path` shim), all of
 * which exist in a `DedicatedWorkerGlobalScope` -- no `document`/`window` assumptions.
 */
import "../go/wasm_exec.js";
import type { CircuitId } from "@kakure/sdk/tx";
import { instantiateWasm, runProveCore } from "./proveCore.js";

// This package's tsconfig uses the "DOM" lib (shared with browser-facing code elsewhere in the
// repo), which is mutually exclusive with the "webworker" lib that would otherwise provide
// `DedicatedWorkerGlobalScope` -- so `self` is typed minimally by hand here instead of pulling in
// the full ambient worker-global type.
interface MinimalWorkerGlobalScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
declare const self: MinimalWorkerGlobalScope;

interface InitMessage {
  readonly type: "init";
  readonly wasmBytes: ArrayBuffer;
}

interface ProveMessage {
  readonly type: "prove";
  readonly requestId: number;
  readonly circuit: CircuitId;
  readonly inputs: Record<string, unknown>;
}

interface PrepareMessage {
  readonly type: "prepare";
  readonly requestId: number;
  readonly circuit: CircuitId;
  readonly acirJson: string;
  readonly ccsBytes: ArrayBuffer;
  readonly pkBytes: ArrayBuffer;
}

type InboundMessage = InitMessage | PrepareMessage | ProveMessage;

let readyPromise: Promise<void> | undefined;
const acirByCircuit = new Map<CircuitId, string>();
let operationQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

self.onmessage = (ev: MessageEvent<InboundMessage>) => {
  const msg = ev.data;

  if (msg.type === "init") {
    readyPromise ??= instantiateWasm(msg.wasmBytes);
    readyPromise
      .then(() => self.postMessage({ type: "ready" }))
      .catch((err: unknown) => self.postMessage({ type: "error", requestId: -1, message: errorMessage(err) }));
    return;
  }

  if (msg.type === "prepare") {
    void enqueue(async () => {
      try {
        if (!readyPromise) throw new Error("prover-wasm worker: received 'prepare' before 'init'");
        await readyPromise;
        const prepare = (
          globalThis as unknown as {
            kakurePrepareCircuit: (
              id: string,
              acirJson: string,
              ccsBytes: Uint8Array,
              pkBytes: Uint8Array,
            ) => Promise<void>;
          }
        ).kakurePrepareCircuit;
        await prepare(
          String(msg.circuit),
          msg.acirJson,
          new Uint8Array(msg.ccsBytes),
          new Uint8Array(msg.pkBytes),
        );
        acirByCircuit.set(msg.circuit, msg.acirJson);
        self.postMessage({ type: "prepared", requestId: msg.requestId });
      } catch (err) {
        self.postMessage({ type: "error", requestId: msg.requestId, message: errorMessage(err) });
      }
    });
    return;
  }

  if (msg.type === "prove") {
    void enqueue(async () => {
      try {
        if (!readyPromise) {
          throw new Error("prover-wasm worker: received 'prove' before 'init'");
        }
        await readyPromise;
        const acirJson = acirByCircuit.get(msg.circuit);
        if (!acirJson) throw new Error(`prover-wasm worker: circuit ${msg.circuit} has not been prepared`);
        const provePrepared = (
          globalThis as unknown as {
            kakureProvePrepared: (
              id: string,
              witnessGz: Uint8Array,
            ) => Promise<{ proof: Uint8Array; pw: Uint8Array }>;
          }
        ).kakureProvePrepared;

        const bundle = await runProveCore({
          circuit: msg.circuit,
          inputs: msg.inputs,
          acirJson,
          ccsBytes: new Uint8Array(),
          pkBytes: new Uint8Array(),
          kakureProve: (_acirJson, witnessGz) => provePrepared(String(msg.circuit), witnessGz),
          onProgress: (stage) => {
            self.postMessage({ type: "progress", requestId: msg.requestId, circuit: msg.circuit, stage });
          },
        });

        const proof = bundle.proof.buffer.slice(
          bundle.proof.byteOffset,
          bundle.proof.byteOffset + bundle.proof.byteLength,
        ) as ArrayBuffer;
        const publicInputs = bundle.publicInputs.map(
          (word) => word.buffer.slice(word.byteOffset, word.byteOffset + word.byteLength) as ArrayBuffer,
        );
        self.postMessage({
          type: "result",
          requestId: msg.requestId,
          proof,
          publicInputs,
        }, [proof, ...publicInputs]);
      } catch (err) {
        self.postMessage({ type: "error", requestId: msg.requestId, message: errorMessage(err) });
      }
    });
  }
};
