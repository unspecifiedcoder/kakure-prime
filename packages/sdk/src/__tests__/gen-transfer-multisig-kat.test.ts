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
  msgTransfer,
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
const MEMO_VALUE = 40n;
const CHANGE_VALUE = 60n;
// recipient_in_pub() in transfer_multisig/src/main.nr
const RECIPIENT_IN_PUB: Point = [
  0x1b16e357953d68d73398c838aa883cc65ddae2aef75a4bc437e4232afdbe43c8n,
  0x02d7ee0be055310d2895c5ed5090a8aa1c700e73c64294f1e817ec77f46b4fdcn,
];
// Transfer memo binds parents to the hidden sentinel (BN254_Fr - 1), not the sender's index.
const PARENTS_HIDDEN =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n -
  1n;

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

describe("gen transfer_multisig KAT", () => {
  it("emits a coherent witness + real 3-of-5 FROST (R,z) over the transfer message", async () => {
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

    const oldNote: Note = {
      noteVersion: new Fr(1n),
      assetId: new Fr(ASSET_ID),
      noteType: new Fr(1n),
      conditionsHash: new Fr(0n),
      value: OLD_VALUE,
      owner,
      psi: new Fr(OLD_PSI),
      parents: new Fr(0n),
    };
    const root = await leaf(oldNote);
    const nullifier = await computeNullifier(new Fr(OLD_PSI), new Fr(0n));

    const [memoEph, changeEph] = evenYEphsFrom(1n, 2);
    const memoPsi = await computePsi(deriveCek(new Fr(memoEph), COMPLIANCE_PK));
    const changePsi = await computePsi(
      deriveCek(new Fr(changeEph), COMPLIANCE_PK),
    );
    const memoOwner = new Fr(await multisigOwner(RECIPIENT_IN_PUB));

    const memoNote: Note = {
      noteVersion: new Fr(1n),
      assetId: new Fr(ASSET_ID),
      noteType: new Fr(0n),
      conditionsHash: new Fr(0n),
      value: MEMO_VALUE,
      owner: memoOwner,
      psi: memoPsi,
      parents: new Fr(PARENTS_HIDDEN),
    };
    const changeNote: Note = {
      noteVersion: new Fr(1n),
      assetId: new Fr(ASSET_ID),
      noteType: new Fr(1n),
      conditionsHash: new Fr(0n),
      value: CHANGE_VALUE,
      owner,
      psi: changePsi,
      parents: new Fr(0n),
    };
    const memoLeaf = await leaf(memoNote);
    const changeLeaf = await leaf(changeNote);

    const m = await msgTransfer({
      root: root.toBigInt(),
      nullifier: nullifier.toBigInt(),
      memoLeaf: memoLeaf.toBigInt(),
      memoTag: RECIPIENT_IN_PUB[0],
      changeLeaf: changeLeaf.toBigInt(),
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

    // gpk MUST equal the shared frost.nr KAT gpk.
    expect(hex(gpk[0])).toBe(
      "0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764d",
    );
    expect(hex(gpk[1])).toBe(
      "0x0d7a564269d3675f75799ee9d7574b00d01190b243041994c0e460af507a71aa",
    );

    // Parity lock: MUST equal the transfer_multisig/src/main.nr KAT.
    // regenerated for kakure.* domains (memoPsi/changePsi/memoLeaf/changeLeaf/sig/m all depend on
    // PSI_DOMAIN/SCHNORR_DOMAIN/ACTION_TRANSFER via computePsi; only `root`/`nullifier`, which
    // reuse the independently-hardcoded OLD_PSI as the pre-existing note's psi, are unchanged.
    // Under the old domain changePsi happened to equal OLD_PSI's numeric value -- pure
    // coincidence of changeEph=5, not a relationship that survives the rename.)
    expect(memoEph).toBe(4n);
    expect(changeEph).toBe(5n);
    expect(hex(memoOwner.toBigInt())).toBe(
      "0x1113074e2fb269d979ad2b64e6fe70b1967c67b007b706600603b847306aefe3",
    );
    expect(hex(memoPsi.toBigInt())).toBe(
      "0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e",
    );
    expect(hex(changePsi.toBigInt())).toBe(
      "0x1a72e6c3463dd2509150c482ad772ede1290d453977279eed05f10ae8cbd75f0",
    );
    expect(hex(root.toBigInt())).toBe(
      "0x037fe99b619334303b77cbf935d2bb8aa52f392c3c1890d3fe9b093dd8a3f750",
    );
    expect(hex(nullifier.toBigInt())).toBe(
      "0x2761654f0b4e9f47ac9bafe900c723ead042a888da718a34b6ecc8036850755e",
    );
    expect(hex(memoLeaf.toBigInt())).toBe(
      "0x162fd3d7f245e8ee9eb2465e1279ee04cd4953b0105a34a61d42e596db925e06",
    );
    expect(hex(changeLeaf.toBigInt())).toBe(
      "0x2beabf0a8519cfc5d23e47313a8099e85735ca1b8886a1903f8fb743f311ab7b",
    );
    expect(hex(sig.R[0])).toBe(
      "0x24e57b1f9a6718f1f762d44405f35a6b7069a324020ac2aa0640271d488fc864",
    );
    expect(hex(sig.R[1])).toBe(
      "0x2634e350fcead5983008f940bc8956cd62adba8c81816ded57f5fba8306bfd87",
    );
    expect(hex(sig.z)).toBe(
      "0x04ff02bb111b27461ff96210e331fc5be63f4fd36ea24dce0a77da9c4ed923c8",
    );
    expect(hex(m)).toBe(
      "0x07b3ed91e5bed32f5abc756b222f7215cae604a882281d5e837052a1842896ee",
    );
  });
});
