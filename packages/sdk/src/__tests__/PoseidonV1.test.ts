import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { poseidonV1Hash3 } from "../crypto/PoseidonV1.js";
import { Poseidon } from "../crypto/Poseidon.js";

/**
 * `poseidonV1Hash3` is `circomlibjs`'s Poseidon (circom/BN254 parameters), matching Solana's `sol_poseidon`
 * syscall and the Noir `poseidon::bn254::hash_3` the pool program will use on-chain (master plan I-5, spec
 * §3.1). It is a DIFFERENT permutation from `crypto/Poseidon.ts`'s Poseidon2 (`@aztec/foundation`'s
 * `poseidon2Hash`) -- notes, nullifiers, owner hashes, the FROST challenge and DEM/KEM all stay on Poseidon2
 * and must never be migrated to this one.
 *
 * RECONCILIATION FLAG (workstream C -> A): `circuits/kat/lean_imt_poseidon_v1.json`, the authoritative
 * cross-checked fixture the master plan asks workstream A to publish, did not exist in the `a-circuits`
 * worktree as of this port. This file cannot self-certify that `circomlibjs`'s Poseidon matches Noir's
 * `poseidon::bn254::hash_3` bit-for-bit (that requires an independent oracle) -- it only certifies
 * `poseidonV1Hash3`'s properties as a TS function (determinism, distinctness from Poseidon2, and, via
 * `LeanImtParity.test.ts`, correct frontier-insert composition). Re-run against `circuits/kat/
 * lean_imt_poseidon_v1.json` once workstream A publishes it, and treat this file's absence as an open
 * integration risk until then.
 */
describe("Poseidon v1 (circom/BN254) tree-node hash", () => {
  it("is deterministic", async () => {
    const [l, r, lvl] = [new Fr(1n), new Fr(2n), new Fr(0n)];
    const h1 = await poseidonV1Hash3(l, r, lvl);
    const h2 = await poseidonV1Hash3(l, r, lvl);
    expect(h1.toString()).toBe(h2.toString());
  });

  it("is sensitive to each of the three inputs (left, right, level)", async () => {
    const base = await poseidonV1Hash3(new Fr(1n), new Fr(2n), new Fr(0n));
    const diffLeft = await poseidonV1Hash3(new Fr(3n), new Fr(2n), new Fr(0n));
    const diffRight = await poseidonV1Hash3(new Fr(1n), new Fr(3n), new Fr(0n));
    const diffLevel = await poseidonV1Hash3(new Fr(1n), new Fr(2n), new Fr(1n));
    expect(base.toString()).not.toBe(diffLeft.toString());
    expect(base.toString()).not.toBe(diffRight.toString());
    expect(base.toString()).not.toBe(diffLevel.toString());
  });

  it("produces a value inside the BN254 scalar field", async () => {
    const h = await poseidonV1Hash3(new Fr(1n), new Fr(2n), new Fr(0n));
    expect(h.toBigInt()).toBeGreaterThanOrEqual(0n);
    expect(h.toBigInt()).toBeLessThan(Fr.MODULUS);
  });

  it("is a DIFFERENT permutation from crypto/Poseidon.ts's Poseidon2, for the same inputs", async () => {
    const v1 = await poseidonV1Hash3(new Fr(1n), new Fr(2n), new Fr(0n));
    const v2 = await Poseidon.hash([new Fr(1n), new Fr(2n), new Fr(0n)]);
    expect(v1.toString()).not.toBe(v2.toString());
  });
});
