import { CircuitId, type ProverPort } from "@kakure/sdk/tx";
import { helperProver, type HelperProverOptions } from "./helperProver.js";
import { realWasmProver, type WasmProgressListener } from "./realWasmProver.js";

export interface ProverRouterOptions {
  helper: HelperProverOptions;
  /** Forwarded to the wasm prover (Deposit/Withdraw only) so a UI can show
   *  "loading proving key…" / "generating privacy proof…" instead of an indefinite spinner. */
  onWasmProgress?: WasmProgressListener;
}

/**
 * Routing policy from the ws-J WASM spike (`packages/prover-wasm`, on branch `ws/j-wasm-prover`,
 * not yet merged to main): the browser gnark/wasm prover is byte-correct end to end, but
 * single-threaded `transfer_multisig` proving (~90-165s in Chromium) is too slow/heavy to ask
 * every co-signer's browser to do it for a batch payroll session. Deposit (~25-50s) and withdraw
 * are fine. So, for v1:
 *   - `CircuitId.Deposit` and `CircuitId.Withdraw` (personal deposits, the recipient claim page's
 *     withdraw) -> `WasmProver` -- zero install, must never require the Kakure Helper.
 *   - `CircuitId.TransferMultisig` (treasury "Pay people" batch) -> `HelperProver`.
 *   - everything else (not yet wired end to end by this workstream: Transfer, SplitMultisig,
 *     JoinMultisig, WithdrawMultisig) defaults to `HelperProver`, the safer of the two until each
 *     is actually exercised.
 *
 * `@kakure/prover-wasm` landed on main at `b00ffa3` (ws-J): `CircuitId.Deposit`/`Withdraw` now
 * route to the real wasm prover (`realWasmProver.ts`, lazily loaded -- see its own doc comment),
 * not a stub. `src/prover/wasmProver.ts`'s `NotImplementedError` stub still exists purely as a
 * seam for tests/fallback and is no longer wired here.
 */
export function proverFor(circuitId: CircuitId, opts: ProverRouterOptions): ProverPort {
  switch (circuitId) {
    case CircuitId.Deposit:
    case CircuitId.Withdraw:
      return realWasmProver(opts.onWasmProgress ? { onProgress: opts.onWasmProgress } : {});
    default:
      return helperProver(opts.helper);
  }
}
