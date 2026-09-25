import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
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
  multisigOwner,
  msgSplit,
  NonceHandle,
  Commitment,
} from "../frost/index.js";
import { leaf, Note } from "../note/note.js";
import { computePsi, computeNullifier } from "../note/nullifier.js";
import { isEvenY } from "../note/keys.js";
import { deriveCek } from "../crypto/kem.js";
import type { Point } from "../tss/index.js";

const ASSET_ID = 0x1234567890123456789012345678901234567890n;
const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const OLD_PSI =
  0x0981a88f9e119b057498a4ab99ed5379a1ea91c642454fc0c07aacc1f5cd5731n;
const OLD_VALUE = 100n;
const OUT1_VALUE = 60n;
const OUT2_VALUE = 40n;

function evenYEphsFrom(start: bigint, n: number): bigint[] {
  const out: bigint[] = [];
  let s = start;
  while (out.length < n) {
    if (isEvenY(mulPointEscalar(Base8, s))) out.push(s);
    s++;
  }
  return out;
}

const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

const msNote = (value: bigint, owner: Fr, psi: Fr, noteType: bigint): Note => ({
  noteVersion: new Fr(1n),
  assetId: new Fr(ASSET_ID),
  noteType: new Fr(noteType),
  conditionsHash: new Fr(0n),
  value,
  owner,
  psi,
  parents: new Fr(0n),
});

describe("gen split_multisig KAT", () => {
  it("emits a coherent witness + real 3-of-5 FROST (R,z) over the split message", async () => {
    const c = 12345678901234567890123456789012345678901234567890n % SUBORDER;
    const coeffs = [
      c,
      98765432109876543210987654321098765432109876543210n % SUBORDER,
      55555555555555555555555555555555555555555555555555n % SUBORDER,
    ];
    const gpk = scalarBaseMul(c);
    const ids = [1n, 2n, 3n];
    const shares = new Map(ids.map((i) => [i, polyEval(coeffs, i)]));
    const owner = new Fr(await multisigOwner(gpk));

    const oldNote = msNote(OLD_VALUE, owner, new Fr(OLD_PSI), 1n);
    const root = await leaf(oldNote);
    const nullifier = await computeNullifier(new Fr(OLD_PSI), new Fr(0n));

    const [eph1, eph2] = evenYEphsFrom(1n, 2);
    const psi1 = await computePsi(deriveCek(new Fr(eph1), COMPLIANCE_PK));
    const psi2 = await computePsi(deriveCek(new Fr(eph2), COMPLIANCE_PK));
    const out1 = msNote(OUT1_VALUE, owner, psi1, 1n);
    const out2 = msNote(OUT2_VALUE, owner, psi2, 1n);
    const out1Leaf = await leaf(out1);
    const out2Leaf = await leaf(out2);

    const m = await msgSplit({
      root: root.toBigInt(),
      nullifier: nullifier.toBigInt(),
      out1Leaf: out1Leaf.toBigInt(),
      out2Leaf: out2Leaf.toBigInt(),
      asset: ASSET_ID,
    });

    const msg = encodeMessage(m);
    const rounds = new Map<
      bigint,
      { nonces: NonceHandle; commitment: Commitment<Point> }
    >();
    for (const i of ids) {
      const h = new Uint8Array(32).fill(Number(i) * 2 + 40);
      const b = new Uint8Array(32).fill(Number(i) * 2 + 41);
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

    expect(hex(gpk[0])).toBe(
      "0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764d",
    );

    // Parity lock: MUST equal the split_multisig/src/main.nr KAT.
    // regenerated for kakure.* domains (psi1/psi2/out1Leaf/out2Leaf/sig/m all depend on
    // PSI_DOMAIN/SCHNORR_DOMAIN/ACTION_SPLIT via computePsi; only `root`/`nullifier`, which reuse
    // the independently-hardcoded OLD_PSI as the pre-existing note's psi, are unchanged. Under the
    // old domain psi2 happened to equal OLD_PSI's numeric value -- pure coincidence of eph2=5, not
    // a relationship that survives the rename.)
    expect(eph1).toBe(4n);
    expect(eph2).toBe(5n);
    expect(hex(psi1.toBigInt())).toBe(
      "0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e",
    );
    expect(hex(psi2.toBigInt())).toBe(
      "0x1a72e6c3463dd2509150c482ad772ede1290d453977279eed05f10ae8cbd75f0",
    );
    expect(hex(root.toBigInt())).toBe(
      "0x037fe99b619334303b77cbf935d2bb8aa52f392c3c1890d3fe9b093dd8a3f750",
    );
    expect(hex(nullifier.toBigInt())).toBe(
      "0x2761654f0b4e9f47ac9bafe900c723ead042a888da718a34b6ecc8036850755e",
    );
    expect(hex(out1Leaf.toBigInt())).toBe(
      "0x1cf40eb86128dbf71af0519f8a91ffc0b6673006212b281e28bdeeb3259917a9",
    );
    expect(hex(out2Leaf.toBigInt())).toBe(
      "0x0ff99c03dc73821e6c6989a76fd1b0dcfb32aa3a079a17678a3fcdaeefd998df",
    );
    expect(hex(sig.R[0])).toBe(
      "0x113d2db340a6faa752b7a09078291d4622b6b525b116efbdf30476066530609b",
    );
    expect(hex(sig.R[1])).toBe(
      "0x125394afe74a84bbd487ba7124deec6befa16af106de43e5d2b4495aff388d98",
    );
    expect(hex(sig.z)).toBe(
      "0x03a8e30852fa2baefee63c855367313bd1c905de91dc5e35715f1e965a3b028c",
    );
    expect(hex(m)).toBe(
      "0x19bce540347a8c3f385b7ffdb0854a5b654ef76363341dae60f99af7d45a7f55",
    );
  });
});
