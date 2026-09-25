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
  msgJoin,
  NonceHandle,
  Commitment,
} from "../frost/index.js";
import { leaf, Note } from "../note/note.js";
import { computePsi, computeNullifier } from "../note/nullifier.js";
import { isEvenY } from "../note/keys.js";
import { deriveCek } from "../crypto/kem.js";
import { Poseidon } from "../crypto/Poseidon.js";
import type { Point } from "../tss/index.js";

const ASSET_ID = 0x1234567890123456789012345678901234567890n;
const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const A_VALUE = 100n;
const B_VALUE = 50n;
const OUT_VALUE = 150n;
const A_PSI = 0x01n;
const B_PSI = 0x02n;
// pack(index_a=0, index_b=1) = 0 + 1*2^32
const OUT_PARENTS = 0x100000000n;

function firstEvenYEph(): bigint {
  for (let s = 1n; s < 1000n; s++) {
    if (isEvenY(mulPointEscalar(Base8, s))) return s;
  }
  throw new Error("no even-y ephemeral in range");
}

const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

const msNote = (
  value: bigint,
  owner: Fr,
  psi: Fr,
  noteType: bigint,
  parents: bigint,
): Note => ({
  noteVersion: new Fr(1n),
  assetId: new Fr(ASSET_ID),
  noteType: new Fr(noteType),
  conditionsHash: new Fr(0n),
  value,
  owner,
  psi,
  parents: new Fr(parents),
});

describe("gen join_multisig KAT", () => {
  it("emits a coherent witness + real 3-of-5 FROST (R,z) over the join message", async () => {
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

    const noteA = msNote(A_VALUE, owner, new Fr(A_PSI), 1n, 0n);
    const noteB = msNote(B_VALUE, owner, new Fr(B_PSI), 1n, 0n);
    const leafA = await leaf(noteA);
    const leafB = await leaf(noteB);
    const root = await Poseidon.hash([leafA, leafB]);
    const nullifierA = await computeNullifier(new Fr(A_PSI), new Fr(0n));
    const nullifierB = await computeNullifier(new Fr(B_PSI), new Fr(1n));

    const ephOut = firstEvenYEph();
    const psiOut = await computePsi(deriveCek(new Fr(ephOut), COMPLIANCE_PK));
    const outNote = msNote(OUT_VALUE, owner, psiOut, 1n, OUT_PARENTS);
    const outLeaf = await leaf(outNote);

    const m = await msgJoin({
      root: root.toBigInt(),
      nullifierA: nullifierA.toBigInt(),
      nullifierB: nullifierB.toBigInt(),
      outLeaf: outLeaf.toBigInt(),
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

    // Parity lock: MUST equal the join_multisig/src/main.nr KAT.
    // regenerated for kakure.* domains (psiOut/outLeaf/sig/m depend on PSI_DOMAIN/SCHNORR_DOMAIN/
    // ACTION_JOIN; gpk/owner/leafA/leafB/root/nullifiers do not and are unchanged).
    expect(ephOut).toBe(4n);
    expect(hex(psiOut.toBigInt())).toBe(
      "0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e",
    );
    expect(hex(leafA.toBigInt())).toBe(
      "0x06231cb767801dfb54ba204853971662673844713bfac80a1365a64395321213",
    );
    expect(hex(leafB.toBigInt())).toBe(
      "0x26afbdd3fb70e3c36549bf153b11f505bd5a09372f3b074bb8a1f3a4c8ef8bbc",
    );
    expect(hex(root.toBigInt())).toBe(
      "0x0fb55082129f15e052308440e29b6a7e2109680582585b886a80ada05f09615b",
    );
    expect(hex(nullifierA.toBigInt())).toBe(
      "0x1e05013a2f40c60dc58cfe36bfa4d7e94676c43436922368628342bc5144d103",
    );
    expect(hex(nullifierB.toBigInt())).toBe(
      "0x176ad1cae93876a4632bc6431edd92ba205845f7e9aa369840c790f261640d1a",
    );
    expect(hex(outLeaf.toBigInt())).toBe(
      "0x18d9bf10d00be59e7f1db73cf92647805a9751727d369e3a3ca6ca59577627f1",
    );
    expect(hex(sig.R[0])).toBe(
      "0x13c104228b58af1b1f7a3587726f68a91a4933b027b608c44d9c6ab03ee238c2",
    );
    expect(hex(sig.R[1])).toBe(
      "0x1fe53317a30eb0acca4cdae929c124b2ffdf841915551002149bd868d8807d8c",
    );
    expect(hex(sig.z)).toBe(
      "0x009d2f3fc523c5f4803b73f948c7dc2428745896380980017828eccbd0432813",
    );
    expect(hex(m)).toBe(
      "0x0f487d0ea0bde23c2fb6f882da4fd15564f40aa52680a2073a5fb7a006971418",
    );
  });
});
