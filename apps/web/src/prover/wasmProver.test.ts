import { describe, it, expect } from "vitest";
import { CircuitId } from "@kakure/sdk/tx";
import { wasmProver, NotImplementedError } from "./wasmProver.js";

describe("wasmProver stub (spec §3A, owned by another workstream)", () => {
  it("prove() throws NotImplementedError pointing at the spec", async () => {
    const port = wasmProver();
    await expect(port.prove(CircuitId.Withdraw, {})).rejects.toBeInstanceOf(NotImplementedError);
    await expect(port.prove(CircuitId.Withdraw, {})).rejects.toThrow(/kakure-customer-app-design\.md §3A/);
  });

  it("capabilities() also throws NotImplementedError (never silently claims 'wasm' support)", async () => {
    const port = wasmProver();
    await expect(port.capabilities()).rejects.toBeInstanceOf(NotImplementedError);
  });
});
