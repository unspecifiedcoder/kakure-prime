import { describe, it, expect } from "vitest";
import { CircuitId, type ProofBundle } from "@kakure/sdk/tx";
import { encodeProofBundle, decodeProofBundle } from "./wire.js";

describe("@kakure/helper wire (base64 ProofBundle codec, no Buffer/btoa dependency)", () => {
  it("round-trips a ProofBundle with arbitrary byte values (0, 255, non-multiple-of-3 lengths)", () => {
    const bundle: ProofBundle = {
      circuitId: CircuitId.TransferMultisig,
      proof: Uint8Array.from({ length: 191 }, (_, i) => i % 256),
      publicInputs: [new Uint8Array(32).fill(0), new Uint8Array(32).fill(255), new Uint8Array([1, 2])],
    };
    const wire = encodeProofBundle(bundle);
    expect(typeof wire.proof).toBe("string");
    const back = decodeProofBundle(wire);
    expect(back.circuitId).toBe(bundle.circuitId);
    expect([...back.proof]).toEqual([...bundle.proof]);
    expect(back.publicInputs.map((pi) => [...pi])).toEqual(bundle.publicInputs.map((pi) => [...pi]));
  });

  it("round-trips an empty byte array", () => {
    const wire = encodeProofBundle({ circuitId: CircuitId.Deposit, proof: new Uint8Array(0), publicInputs: [] });
    const back = decodeProofBundle(wire);
    expect(back.proof.length).toBe(0);
    expect(back.publicInputs).toEqual([]);
  });
});
