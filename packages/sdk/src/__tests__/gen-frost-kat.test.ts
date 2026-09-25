import { describe, it, expect } from "vitest";
import { scalarBaseMul, polyEval, SUBORDER } from "../tss/index.js";
import {
  bjjCiphersuite as cs,
  encodeMessage,
  commit,
  groupCommitment,
  bindingFactors,
  signShare,
  aggregate,
  verify,
  NonceHandle,
  Commitment,
} from "../frost/index.js";
import type { Point } from "../tss/index.js";

describe("gen frost KAT", () => {
  it("emits a deterministic FROST (R,z)", async () => {
    const c = 12345678901234567890123456789012345678901234567890n % SUBORDER;
    const coeffs = [
      c,
      98765432109876543210987654321098765432109876543210n % SUBORDER,
      55555555555555555555555555555555555555555555555555n % SUBORDER,
    ];
    const gpk = scalarBaseMul(c);
    const ids = [1n, 2n, 3n];
    const shares = new Map(ids.map((i) => [i, polyEval(coeffs, i)]));
    const m =
      0x0abcdef1234567890fedcba9876543210abcdef1234567890fedcba98765432n;
    const msg = encodeMessage(m);

    const rounds = new Map<
      bigint,
      { nonces: NonceHandle; commitment: Commitment<Point> }
    >();
    for (const i of ids) {
      const h = new Uint8Array(32).fill(Number(i) * 2);
      const b = new Uint8Array(32).fill(Number(i) * 2 + 1);
      rounds.set(i, await commit(cs, i, shares.get(i)!, h, b));
    }
    const commitments = ids.map((i) => rounds.get(i)!.commitment);
    const zs: bigint[] = [];
    for (const i of ids)
      zs.push(
        await signShare(
          cs,
          i,
          rounds.get(i)!.nonces,
          shares.get(i)!,
          gpk,
          msg,
          commitments,
        ),
      );
    const R = groupCommitment(
      cs,
      commitments,
      await bindingFactors(cs, gpk, msg, commitments),
    );
    const sig = aggregate(cs, R, zs);
    expect(await verify(cs, gpk, msg, sig)).toBe(true);

    // Parity lock: MUST equal the Noir verify_frost_spend KAT (shared/src/multisig/frost.nr).
    // regenerated for kakure.* domains (SCHNORR_DOMAIN moved; gpk is unaffected since it does not
    // depend on the challenge domain).
    const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
    expect(hex(gpk[0])).toBe(
      "0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764d",
    );
    expect(hex(gpk[1])).toBe(
      "0x0d7a564269d3675f75799ee9d7574b00d01190b243041994c0e460af507a71aa",
    );
    expect(hex(sig.R[0])).toBe(
      "0x1f2290f4eabfc9f6bee4d67916231d3d08c31b78de159c9212fe9bf0371ec094",
    );
    expect(hex(sig.R[1])).toBe(
      "0x1bccaf427b6b2e0819ae1b69e06ee52f9641b698dbb34dd5f7c56594708a226d",
    );
    expect(hex(sig.z)).toBe(
      "0x05b830d053ab8ba988e76ff32e9fbad4be651fcd5d9405e6f12c9b612800df54",
    );
    expect(hex(m)).toBe(
      "0x00abcdef1234567890fedcba9876543210abcdef1234567890fedcba98765432",
    );
  });
});
