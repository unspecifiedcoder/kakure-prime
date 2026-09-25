import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CircuitId, type ProofBundle, type ProverPort } from "@kakure/sdk/tx";
import { runDeposit } from "../deposit.js";

function fakeProver(): ProverPort {
  return {
    async capabilities() {
      return { circuits: [CircuitId.Deposit], environment: "native" as const };
    },
    async prove(circuit, inputs): Promise<ProofBundle> {
      expect(circuit).toBe(CircuitId.Deposit);
      expect(inputs).toHaveProperty("note");
      expect(inputs).toHaveProperty("eph");
      return {
        circuitId: CircuitId.Deposit,
        // Workstream G: TxBuilder now expects the COMPRESSED 192-byte proof a real
        // @kakure/prover's prove() would return (see tx/ports.ts's ProofBundle doc comment).
        proof: new Uint8Array(192).fill(9),
        publicInputs: Array.from({ length: 13 }, () => new Uint8Array(32)),
      };
    },
  };
}

describe("runDeposit (dry run, fake prover)", () => {
  it("mints a self note, calls the prover with the real note fields, and builds a deposit instruction", async () => {
    const keypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const programId = Keypair.generate().publicKey;

    const result = await runDeposit({
      keypair,
      mint,
      amount: 1_000n,
      // Real BabyJubJub point (circuits/shared/src/common/test_fixtures.nr's FIXTURE_COMPLIANCE_{X,Y}) --
      // deriveCek does an actual ECDH against this, so a fake curve point fails on-curve validation.
      compliancePk: [
        0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
        0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
      ],
      prover: fakeProver(),
      programId,
      accounts: {
        pool: PublicKey.default,
        asset: PublicKey.default,
        mint,
        vault: PublicKey.default,
        depositorTokenAccount: PublicKey.default,
        depositor: keypair.publicKey,
        verifierProgram: PublicKey.default,
        tokenProgram: PublicKey.default,
      },
    });

    expect(result.minted.note.value.toBigInt()).toBe(1_000n);
    expect(result.bundle.circuitId).toBe(CircuitId.Deposit);
    // computeBudget ix + the deposit ix itself.
    expect(result.instructions).toHaveLength(2);
    expect(result.signature).toBeUndefined();
  });
});
