import { describe, expect, it } from "vitest";
import {
  Fr,
  demEncrypt,
  toFr,
  mintIncomingNote,
  canonicalIncomingAddress,
  deriveIncomingKey,
} from "@kakure/sdk";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { scanSingleKey } from "./singleKeyScan.js";
import { isEvenY } from "@kakure/sdk";

// The on-chain event only carries `eph_pub_x`; the recipient recomputes an EVEN-y point from it
// (`recoverEvenY`), so a memo ephemeral must land on even y at mint time or it is unrecoverable.
function evenYEphScalar(seed: bigint): Fr {
  for (let i = 0n; i < 256n; i++) {
    const candidate = new Fr(seed + i);
    if (isEvenY(mulPointEscalar(Base8, candidate.toBigInt()))) return candidate;
  }
  throw new Error("no even-y ephemeral found near seed");
}

const COMPLIANCE_PK = mulPointEscalar(Base8, 777n);
const COMPLIANCE_RESPONSE = [
  {
    version: 1,
    x: new Fr(COMPLIANCE_PK[0]).toString(),
    y: new Fr(COMPLIANCE_PK[1]).toString(),
    from_slot: 0,
  },
];

/** A fake `fetch` serving the indexer's I-8 endpoints this scanner touches: `/compliance` and `/notes`. */
function fakeIndexer(notes: unknown[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/compliance")) {
      return new Response(JSON.stringify(COMPLIANCE_RESPONSE), { status: 200 });
    }
    if (url.includes("/notes")) {
      return new Response(JSON.stringify(notes), { status: 200 });
    }
    throw new Error(`fakeIndexer: unexpected URL ${url}`);
  }) as typeof fetch;
}

describe("scanSingleKey", () => {
  it("decrypts a note paid to the view key's incoming address and reports its balance", async () => {
    const viewKey = new Fr(555555n);
    const addr = await canonicalIncomingAddress(viewKey, 0n);

    const ephScalar = evenYEphScalar(999n);
    const assetId = toFr(0xabcdn);
    const value = 42000n;

    // `mintIncomingNote`'s 4th argument is the recipient's OWN incoming key (used to derive the note's
    // owner commitment, matching what a real sender only knows via the published `addr.pub`).
    const inKey = await deriveIncomingKey(viewKey, addr.index);
    const rebuilt = await mintIncomingNote(ephScalar, value, addr.pub, inKey, assetId, COMPLIANCE_PK);

    const plaintext = [
      rebuilt.note.noteVersion,
      rebuilt.note.assetId,
      rebuilt.note.noteType,
      rebuilt.note.conditionsHash,
      rebuilt.note.value,
      rebuilt.note.owner,
      rebuilt.note.parents,
    ];
    const ciphertext = await demEncrypt(rebuilt.cek, plaintext);

    const event = {
      leaf_index: 0,
      leaf: rebuilt.commitment.toString(),
      eph_pub_x: new Fr(rebuilt.ephPub[0]).toString(),
      tag: rebuilt.tag.toString(),
      cek_wrap: rebuilt.cekWrap!.toString(),
      ciphertext: ciphertext.map((c) => c.toString()),
      root: "0x00",
    };

    const result = await scanSingleKey(
      "http://fake-indexer.invalid",
      viewKey.toString(),
      fakeIndexer([event]),
    );

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.note.value).toBe(value);
    expect(result.notes[0]!.spent).toBe(false);
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0]!.total).toBe(value);
  });

  it("returns no notes/balances when the indexer has nothing for this key", async () => {
    const viewKey = new Fr(1n);
    const result = await scanSingleKey("http://fake-indexer.invalid", viewKey.toString(), fakeIndexer([]));
    expect(result.notes).toHaveLength(0);
    expect(result.balances).toHaveLength(0);
  });
});
