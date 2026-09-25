import type { ProverPort } from "@kakure/sdk/tx";

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: not implemented yet — see docs/superpowers/specs/2026-09-05-kakure-customer-app-design.md §3A`);
    this.name = "NotImplementedError";
  }
}

/**
 * §3A target: gnark -> WebAssembly proving, entirely client-side (required for the recipient claim
 * page — never talks to the Kakure Helper or any server). Owned by a separate workstream; this
 * stub exists so `apps/web` compiles and routes against the exact `ProverPort` shape today, and so
 * swapping the real implementation in later is a one-line change (see `src/prover/index.ts`).
 */
export function wasmProver(): ProverPort {
  return {
    async capabilities() {
      throw new NotImplementedError("WasmProver.capabilities()");
    },
    async prove() {
      throw new NotImplementedError("WasmProver.prove()");
    },
  };
}
