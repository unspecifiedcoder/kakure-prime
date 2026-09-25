import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { computePsi, computeNullifier } from "../note/nullifier.js";

const CEK = new Fr(
  0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bdan,
);
// regenerated for kakure.* domains (PSI_DOMAIN moved)
const EXPECTED_PSI = new Fr(
  0x1f33fe53db83297049bd83916d5c35eeff3cdd1a9cbb644c06441cd02d6d55cdn,
);
const EXPECTED_NULLIFIER = new Fr(
  0x0af38f7cb7dfb742069be7c29bf6ea8ce322842abd873ce47bb6a35319d6231en,
);

describe("psi + psi-nullifier (Noir parity)", () => {
  it("KAT: psi = Poseidon2(CEK, PSI_DOMAIN)", async () => {
    const psi = await computePsi(CEK);
    expect(psi.equals(EXPECTED_PSI)).toBe(true);
  });

  it("KAT: nullifier = Poseidon2(psi, leaf_index=3)", async () => {
    const psi = await computePsi(CEK);
    const nf = await computeNullifier(psi, new Fr(3n));
    expect(nf.equals(EXPECTED_NULLIFIER)).toBe(true);
  });

  it("non-collision: psi differs from CEK", async () => {
    const psi = await computePsi(CEK);
    expect(psi.equals(CEK)).toBe(false);
  });

  it("distinct leaf indices yield distinct nullifiers for one psi", async () => {
    const psi = await computePsi(CEK);
    const nf3 = await computeNullifier(psi, new Fr(3n));
    const nf4 = await computeNullifier(psi, new Fr(4n));
    expect(nf3.equals(nf4)).toBe(false);
  });
});
