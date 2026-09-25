import { describe, expect, it } from "vitest";
import { Fr, demEncrypt, toFr, computePsi, leaf as computeLeaf, isEvenY } from "@kakure/sdk";
import { multisigAddress, buildIncomingMultisigNote, NOTE_TYPE_MULTISIG } from "@kakure/sdk/frost";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { scanMultisigGroup } from "./multisigScan.js";

// The on-chain event only carries `eph_pub_x`; the recipient recomputes an EVEN-y point from it, so a
// memo/incoming ephemeral must land on even y at mint time or it is unrecoverable (see NoteProcessor's
// `recoverEvenY` / MultisigScanner's equivalent).
function evenYEphScalar(seed: bigint): Fr {
  for (let i = 0n; i < 256n; i++) {
    const candidate = new Fr(seed + i);
    if (isEvenY(mulPointEscalar(Base8, candidate.toBigInt()))) return candidate;
  }
  throw new Error("no even-y ephemeral found near seed");
}

const COMPLIANCE_PK = mulPointEscalar(Base8, 55n);
const COMPLIANCE_RESPONSE = [
  {
    version: 1,
    x: new Fr(COMPLIANCE_PK[0]).toString(),
    y: new Fr(COMPLIANCE_PK[1]).toString(),
    from_slot: 0,
  },
];

function fakeIndexer(notes: unknown[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/compliance")) return new Response(JSON.stringify(COMPLIANCE_RESPONSE), { status: 200 });
    if (url.includes("/notes")) return new Response(JSON.stringify(notes), { status: 200 });
    throw new Error(`fakeIndexer: unexpected URL ${url}`);
  }) as typeof fetch;
}

describe("scanMultisigGroup", () => {
  it("decrypts a note paid to the group's incoming address and reports its balance", async () => {
    const v = new Fr(31337n);
    const gpk = mulPointEscalar(Base8, 424242n);
    const addr = await multisigAddress(gpk, v, 0n);

    const ephScalar = evenYEphScalar(2468n);
    const built = await buildIncomingMultisigNote(ephScalar, COMPLIANCE_PK, gpk, addr.viewPub);

    const assetId = toFr(0x9999n);
    const value = 7500n;
    const note = {
      noteVersion: new Fr(1n),
      assetId,
      noteType: new Fr(NOTE_TYPE_MULTISIG),
      conditionsHash: new Fr(0n),
      value,
      owner: built.owner,
      psi: new Fr(0n), // recomputed by the scanner from cek; unused pre-encrypt
      parents: new Fr(0n),
    };
    // psi is derived from cek by the recipient, not transmitted -- see NoteProcessor/MultisigScanner.
    const psi = await computePsi(built.cek);
    const fullNote = { ...note, psi };
    const commitment = await computeLeaf(fullNote);

    const plaintext = [
      fullNote.noteVersion,
      fullNote.assetId,
      fullNote.noteType,
      fullNote.conditionsHash,
      new Fr(fullNote.value),
      fullNote.owner,
      fullNote.parents,
    ];
    const ciphertext = await demEncrypt(built.cek, plaintext);

    const event = {
      leaf_index: 0,
      leaf: commitment.toString(),
      eph_pub_x: new Fr(built.ephPub[0]).toString(),
      tag: built.tag.toString(),
      cek_wrap: built.cekWrap.toString(),
      ciphertext: ciphertext.map((c) => c.toString()),
      root: "0x00",
    };

    const result = await scanMultisigGroup(
      "http://fake-indexer.invalid",
      {
        v: v.toString(),
        gpkX: new Fr(gpk[0]).toString(),
        gpkY: new Fr(gpk[1]).toString(),
        memberIds: ["1", "2", "3"],
      },
      fakeIndexer([event]),
    );

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.note.value).toBe(value);
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0]!.total).toBe(value);
  });

  it("returns nothing when the indexer has no notes for the group", async () => {
    const v = new Fr(1n);
    const gpk = mulPointEscalar(Base8, 2n);
    const result = await scanMultisigGroup(
      "http://fake-indexer.invalid",
      { v: v.toString(), gpkX: new Fr(gpk[0]).toString(), gpkY: new Fr(gpk[1]).toString(), memberIds: ["1"] },
      fakeIndexer([]),
    );
    expect(result.notes).toHaveLength(0);
    expect(result.balances).toHaveLength(0);
  });
});
