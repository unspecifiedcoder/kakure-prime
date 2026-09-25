import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import {
  combineGroupViewContributions,
  type GroupViewContribution,
} from "../tss/groupSecret.js";
import { deriveGroupViewKeyFromSecret } from "../frost/groupViewKey.js";
import { Point, scalarBaseMul, randScalar } from "../tss/bjj.js";
import { isEvenY } from "../note/keys.js";
import {
  multisigAddress,
  multisigIncomingKeyAt,
  buildIncomingMultisigNote,
  memberReadIncoming,
  MultisigScanner,
  incomingNoteEvent,
  NOTE_TYPE_MULTISIG,
} from "../frost/index.js";
import { computePsi } from "../note/nullifier.js";
import { leaf as computeLeaf, Note } from "../note/note.js";
import { demEncrypt } from "../crypto/dem.js";

// Master plan follow-up: `deriveGroupViewKey(account, gpk)` derived `v` from the calling member's OWN
// personal view key, so a treasury had no single canonical `(gpk, V)` receiving address -- every
// non-creator member computed a different `v`. This file exercises the fix: a group-shared view secret
// (`gvs`), combined from every member's DKG round-2 contribution, from which every member derives the
// IDENTICAL `(v, V)` via `deriveGroupViewKeyFromSecret`.

function randR(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function makeContributions(n: number): GroupViewContribution[] {
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, r: randR() }));
}

async function encryptNote(
  cek: Fr,
  owner: Fr,
  value: bigint,
  asset: Fr,
): Promise<{ note: Note; commitment: Fr; ciphertext: Fr[] }> {
  const psi = await computePsi(cek);
  const note: Note = {
    noteVersion: new Fr(1n),
    assetId: asset,
    noteType: new Fr(NOTE_TYPE_MULTISIG),
    conditionsHash: new Fr(0n),
    value,
    owner,
    psi,
    parents: new Fr(0n),
  };
  const commitment = await computeLeaf(note);
  const ciphertext = await demEncrypt(cek, [
    note.noteVersion,
    note.assetId,
    note.noteType,
    note.conditionsHash,
    new Fr(value),
    note.owner,
    note.parents,
  ]);
  return { note, commitment, ciphertext };
}

describe("combineGroupViewContributions + deriveGroupViewKeyFromSecret (canonical group view secret)", () => {
  it("two members combining the SAME contributions derive identical (v, V)", async () => {
    const gpk: Point = scalarBaseMul(randScalar());
    const contribs = makeContributions(5);

    // "Member A" collects the contributions in one order...
    const gvsA = await combineGroupViewContributions(contribs, gpk);
    const a = await deriveGroupViewKeyFromSecret(gvsA, gpk);

    // ...and "member B" collects the exact same set, shuffled (round-2 messages need not arrive in
    // index order) -- combineGroupViewContributions sorts internally, so this must not matter.
    const shuffled = [...contribs].reverse();
    const gvsB = await combineGroupViewContributions(shuffled, gpk);
    const b = await deriveGroupViewKeyFromSecret(gvsB, gpk);

    expect(gvsB.toString()).toBe(gvsA.toString());
    expect(b.v.toString()).toBe(a.v.toString());
    expect(b.V[0]).toBe(a.V[0]);
    expect(b.V[1]).toBe(a.V[1]);
    expect(isEvenY(a.V)).toBe(true);
  });

  it("a member with a wrong (incomplete/tampered) contribution set gets a different V", async () => {
    const gpk: Point = scalarBaseMul(randScalar());
    const contribs = makeContributions(5);

    const gvsCorrect = await combineGroupViewContributions(contribs, gpk);
    const correct = await deriveGroupViewKeyFromSecret(gvsCorrect, gpk);

    // Missing one member's contribution (e.g. it never arrived).
    const incomplete = contribs.slice(0, 4);
    const gvsWrong = await combineGroupViewContributions(incomplete, gpk);
    const wrong = await deriveGroupViewKeyFromSecret(gvsWrong, gpk);

    expect(wrong.v.toString()).not.toBe(correct.v.toString());
    expect(wrong.V[0]).not.toBe(correct.V[0]);
  });

  it("rejects a malformed contribution (wrong length, duplicate index)", async () => {
    const gpk: Point = scalarBaseMul(randScalar());
    await expect(
      combineGroupViewContributions(
        [{ index: 1, r: new Uint8Array(16) }],
        gpk,
      ),
    ).rejects.toThrow(/32 bytes/);

    const r = randR();
    await expect(
      combineGroupViewContributions(
        [
          { index: 1, r },
          { index: 1, r },
        ],
        gpk,
      ),
    ).rejects.toThrow(/duplicate/);

    await expect(combineGroupViewContributions([], gpk)).rejects.toThrow(
      /at least one/,
    );
  });

  it("binds gvs to gpk: the same contributions under a different group give a different secret", async () => {
    const contribs = makeContributions(3);
    const gpk1: Point = scalarBaseMul(randScalar());
    const gpk2: Point = scalarBaseMul(randScalar());
    const gvs1 = await combineGroupViewContributions(contribs, gpk1);
    const gvs2 = await combineGroupViewContributions(contribs, gpk2);
    expect(gvs1.toString()).not.toBe(gvs2.toString());
  });

  it("scanning an incoming multisig note built with buildIncomingMultisigNote(..., V) succeeds with the canonical v", async () => {
    const gpk: Point = scalarBaseMul(randScalar());
    const compliancePk: Point = scalarBaseMul(randScalar());
    const asset = new Fr(0xabcdefn);
    const memberIds = [1n, 2n, 3n];
    const contribs = makeContributions(3);

    // Two independent "members" each combine the same DKG contributions on their own machine.
    const gvsAlice = await combineGroupViewContributions(contribs, gpk);
    const { v: vAlice } = await deriveGroupViewKeyFromSecret(gvsAlice, gpk);
    const gvsBob = await combineGroupViewContributions([...contribs].reverse(), gpk);
    const { v: vBob } = await deriveGroupViewKeyFromSecret(gvsBob, gpk);
    expect(vBob.toString()).toBe(vAlice.toString()); // canonical: both hold the same v

    // Alice publishes the group's one canonical receiving address, (gpk, V).
    const { viewPub: V } = await multisigAddress(gpk, vAlice);

    let eph = new Fr(randScalar());
    while (!isEvenY(scalarBaseMul(eph.toBigInt()))) eph = new Fr(randScalar());
    const inc = await buildIncomingMultisigNote(eph, compliancePk, gpk, V);
    const enc = await encryptNote(inc.cek, inc.owner, 250n, asset);

    // Bob (who never talked to Alice beyond the DKG round-2 exchange) scans with HIS independently
    // combined v and finds the same note -- the fix, demonstrated end to end.
    const bobScanner = await MultisigScanner.create({
      v: vBob,
      gpk,
      compliancePk,
      memberIds,
      selfWindow: 16,
    });
    const view = await bobScanner.readNote(
      incomingNoteEvent({
        leafIndex: 1n,
        commitment: enc.commitment,
        ephPub: inc.ephPub,
        tag: inc.tag,
        cekWrap: inc.cekWrap,
        packedCiphertext: enc.ciphertext,
      }),
    );

    expect(view).not.toBeNull();
    expect(view!.note.value).toBe(250n);
    expect(view!.isIncoming).toBe(true);

    // Also the direct crypto-level check: unwrapping with the ROTATED secret behind V (derived from
    // Bob's independently-combined v, per multisigIncomingKeyAt -- the same relationship
    // `buildIncomingMultisigNote`/`memberReadIncoming` use everywhere else, see multisig-note.test.ts)
    // recovers the same content key regardless of whether Alice's or Bob's v produced it.
    const { viewKey: bobViewKey } = await multisigIncomingKeyAt(vBob, 0n);
    const recovered = await memberReadIncoming(inc.cekWrap, bobViewKey, inc.ephPub);
    expect(recovered.equals(inc.cek)).toBe(true);
  });
});
