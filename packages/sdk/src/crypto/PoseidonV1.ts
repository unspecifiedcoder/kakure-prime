import { Fr } from "@aztec/foundation/fields";
import { buildPoseidon } from "circomlibjs";

/**
 * Poseidon v1 (circom/BN254 parameters), used ONLY for the LeanIMT tree's node hash (spec §3.1 / master
 * plan I-5): `node = poseidon_v1([left, right, level])`. Every other hash in this package (note
 * commitments, `psi`, nullifiers, owner hashes, the FROST challenge, DEM/KEM) stays Poseidon2 via
 * `crypto/Poseidon.ts` and MUST NOT be touched.
 *
 * This is deliberately a different algorithm from `crypto/Poseidon.ts`'s Poseidon2: Solana's `sol_poseidon`
 * syscall implements circom's Poseidon v1 over BN254 (<=12 inputs), and hand-rolled Poseidon2 in SBF would
 * blow the compute budget, so the on-chain pool recomputes tree nodes with v1. `circomlibjs`'s `poseidon`
 * is the standard circom-compatible JS implementation, matching `sol_poseidon` bit-for-bit for inputs in
 * this field.
 */
let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;

async function poseidon(): Promise<{
  hash: (inputs: bigint[]) => bigint;
}> {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  const instance = await poseidonPromise;
  return {
    hash: (inputs: bigint[]) => instance.F.toObject(instance(inputs)) as bigint,
  };
}

/** `poseidon_v1([left, right, level])`, matching `poseidon::bn254::hash_3` in the Noir `shared` crate and
 *  Solana's `sol_poseidon` syscall as recomputed by `kakure_pool`'s frontier insert. */
export async function poseidonV1Hash3(left: Fr, right: Fr, level: Fr): Promise<Fr> {
  const p = await poseidon();
  const out = p.hash([left.toBigInt(), right.toBigInt(), level.toBigInt()]);
  return new Fr(out);
}
