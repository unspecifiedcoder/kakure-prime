import { describe, it, expect, beforeAll } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Point } from "@zk-kit/baby-jubjub";
import {
  canonicalPublicAddress,
  deriveIncomingKey,
  derivePublicIncomingKey,
  deriveSelfEphemeral,
  deriveViewKey,
  isEvenY,
  publicKey,
} from "../note/keys";
import {
  encodeKakureAddress,
  decodeKakureAddress,
  encodeKakurePublicAddress,
  decodeKakurePublicAddress,
} from "../address";
import { calculatePublicMemoId } from "../crypto/index";

const frHex = (f: Fr): string => "0x" + f.toBuffer().toString("hex");

const SK_ROOT = new Fr(0x2an);

// Freezes the "kakure.pubIn" label and the index binding: a change here silently renumbers every
// published receiving address and strands funds already escrowed to the old point.
// regenerated for kakure.* domains
const PUB_IN_KEY_J0 =
  "0x00c13b63635b456d0d96ec1ed75c831830235bfc4d56406e93422345e7636b41";
const PUB_IN_J0_X =
  0x30250d0550b545c61c66b89d48fd08acba2545e71d4311ca01926ba4a8066fd2n;
const PUB_IN_J0_Y =
  0xb2b17529e0e841ce6145ea5b1db4e25784d08eae48b8dfe0cb923ba4a560712n;
// Index 2's derived point under kakure.pubIn (used for the odd-y "keeps the requested index" case).
const PUB_IN_ODD_X =
  0x1a2f20d3a50fd9f306f7af90686f143285a81d25568e66c06635efa50f01692cn;
const PUB_IN_ODD_Y =
  0xe44581921a971b8e54dc152a1c3c597b732fbaff1f7a68cec8eb7ce21d7bba7n;

const EVEN_Y_INDEX = 0n;
const ODD_Y_INDEX = 2n;

// Order-2 point (0, -1): on the curve, outside the prime-order subgroup, so no public_claim witness reaches it.
const ORDER_TWO_POINT: Point<bigint> = [
  0n,
  21888242871839275222246405745257275088548364400416034343698204186575808495616n,
];

describe("public receiving keys are a separate family from private incoming keys", () => {
  let sk_view: Fr;

  beforeAll(async () => {
    sk_view = await deriveViewKey(SK_ROOT);
  });

  it("pins the kakure.pubIn derivation", async () => {
    const key = await derivePublicIncomingKey(sk_view, 0n);
    expect(frHex(key)).toBe(PUB_IN_KEY_J0);
    const pub = publicKey(key);
    expect(pub[0]).toBe(PUB_IN_J0_X);
    expect(pub[1]).toBe(PUB_IN_J0_Y);
  });

  it("produces a different point than the private families at the same index", async () => {
    for (let index = 0n; index < 4n; index++) {
      const pub = publicKey(await derivePublicIncomingKey(sk_view, index));
      const incoming = publicKey(await deriveIncomingKey(sk_view, index));
      const selfEph = publicKey(await deriveSelfEphemeral(sk_view, index));
      expect(
        pub[0],
        `index ${index} collides with the incoming family`,
      ).not.toBe(incoming[0]);
      expect(pub[0], `index ${index} collides with the self family`).not.toBe(
        selfEph[0],
      );
    }
  });

  it("keeps the requested index even when the point has odd y", async () => {
    const addr = await canonicalPublicAddress(sk_view, ODD_Y_INDEX);
    expect(isEvenY(addr.pub)).toBe(false);
    expect(addr.index).toBe(ODD_Y_INDEX);
    expect(addr.pub[0]).toBe(PUB_IN_ODD_X);
    expect(addr.pub[1]).toBe(PUB_IN_ODD_Y);
  });
});

describe("public address codec", () => {
  let sk_view: Fr;

  beforeAll(async () => {
    sk_view = await deriveViewKey(SK_ROOT);
  });

  it("round-trips both y parities without loss", async () => {
    for (const index of [ODD_Y_INDEX, EVEN_Y_INDEX]) {
      const addr = await canonicalPublicAddress(sk_view, index);
      const decoded = decodeKakurePublicAddress(
        encodeKakurePublicAddress({ ownerPub: addr.pub, index: addr.index }),
      );
      expect(decoded.ownerPub[0]).toBe(addr.pub[0]);
      expect(decoded.ownerPub[1]).toBe(addr.pub[1]);
      expect(decoded.index).toBe(index);
    }
  });

  it("uses the kakpub_ prefix", async () => {
    const addr = await canonicalPublicAddress(sk_view, EVEN_Y_INDEX);
    const encoded = encodeKakurePublicAddress({
      ownerPub: addr.pub,
      index: addr.index,
    });
    expect(encoded.startsWith("kakpub_")).toBe(true);
    expect(encoded.startsWith("kak_")).toBe(false);
  });

  it("rejects a private address, naming the decoder to use", async () => {
    const canonical = await canonicalPublicAddress(sk_view, EVEN_Y_INDEX);
    const privateAddress = encodeKakureAddress({
      inPub: canonical.pub,
      index: canonical.index,
    });
    expect(() => decodeKakurePublicAddress(privateAddress)).toThrow(
      /private payment address/,
    );
    expect(() => decodeKakurePublicAddress(privateAddress)).toThrow(/kakpub_/);
  });

  it("rejects a public address in the private decoder", async () => {
    const addr = await canonicalPublicAddress(sk_view, EVEN_Y_INDEX);
    const publicAddress = encodeKakurePublicAddress({
      ownerPub: addr.pub,
      index: addr.index,
    });
    expect(() => decodeKakureAddress(publicAddress)).toThrow(
      /decodeKakurePublicAddress/,
    );
  });

  it("rejects an unknown prefix", async () => {
    const addr = await canonicalPublicAddress(sk_view, EVEN_Y_INDEX);
    const tampered = encodeKakurePublicAddress({
      ownerPub: addr.pub,
      index: addr.index,
    }).replace("kakpub_", "invalid_");
    expect(() => decodeKakurePublicAddress(tampered)).toThrow(/prefix/);
  });

  it("rejects a corrupted checksum", async () => {
    const addr = await canonicalPublicAddress(sk_view, EVEN_Y_INDEX);
    const parts = encodeKakurePublicAddress({
      ownerPub: addr.pub,
      index: addr.index,
    }).split("_");
    const last = parts[1].slice(-1);
    const flipped = last === "A" ? "B" : "A";
    expect(() =>
      decodeKakurePublicAddress(
        `${parts[0]}_${parts[1].slice(0, -1)}${flipped}`,
      ),
    ).toThrow(/checksum/i);
  });

  it("rejects an off-curve owner point", () => {
    expect(() =>
      encodeKakurePublicAddress({
        ownerPub: [1n, 2n] as Point<bigint>,
        index: 0n,
      }),
    ).toThrow(/curve/);
  });

  it("rejects an owner point outside the prime-order subgroup", () => {
    expect(() =>
      encodeKakurePublicAddress({ ownerPub: ORDER_TWO_POINT, index: 0n }),
    ).toThrow(/subgroup/);
  });

  it("feeds the memo id that the public-transfer instruction computes", async () => {
    const addr = await canonicalPublicAddress(sk_view, ODD_Y_INDEX);
    const decoded = decodeKakurePublicAddress(
      encodeKakurePublicAddress({ ownerPub: addr.pub, index: addr.index }),
    );
    const memoId = await calculatePublicMemoId(
      new Fr(100n),
      new Fr(0x1234567890123456789012345678901234567890n),
      new Fr(0n),
      new Fr(decoded.ownerPub[0]),
      new Fr(decoded.ownerPub[1]),
      new Fr(7n),
    );
    const direct = await calculatePublicMemoId(
      new Fr(100n),
      new Fr(0x1234567890123456789012345678901234567890n),
      new Fr(0n),
      new Fr(addr.pub[0]),
      new Fr(addr.pub[1]),
      new Fr(7n),
    );
    expect(memoId.equals(direct)).toBe(true);
  });
});
