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
 *   -> {type:"prove", requestId, circuit, inputs, acirJson, ccsBytes: ArrayBuffer, pkBytes: ArrayBuffer}
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
  postMessage(message: unknown): void;
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
  readonly acirJson: string;
  readonly ccsBytes: ArrayBuffer;
  readonly pkBytes: ArrayBuffer;
}

type InboundMessage = InitMessage | ProveMessage;

let readyPromise: Promise<void> | undefined;

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

  if (msg.type === "prove") {
    void (async () => {
      try {
        if (!readyPromise) {
          throw new Error("prover-wasm worker: received 'prove' before 'init'");
        }
        await readyPromise;
        const kakureProve = (globalThis as unknown as { kakureProve: import("./proveCore.js").KakureProveFn })
          .kakureProve;

        const bundle = await runProveCore({
          circuit: msg.circuit,
          inputs: msg.inputs,
          acirJson: msg.acirJson,
          ccsBytes: new Uint8Array(msg.ccsBytes),
          pkBytes: new Uint8Array(msg.pkBytes),
          kakureProve,
          onProgress: (stage) => {
            self.postMessage({ type: "progress", requestId: msg.requestId, circuit: msg.circuit, stage });
          },
        });

        self.postMessage({
          type: "result",
          requestId: msg.requestId,
          proof: bundle.proof.buffer.slice(
            bundle.proof.byteOffset,
            bundle.proof.byteOffset + bundle.proof.byteLength,
          ),
          publicInputs: bundle.publicInputs.map((word) =>
            word.buffer.slice(word.byteOffset, word.byteOffset + word.byteLength),
          ),
        });
      } catch (err) {
        self.postMessage({ type: "error", requestId: msg.requestId, message: errorMessage(err) });
      }
    })();
  }
};
