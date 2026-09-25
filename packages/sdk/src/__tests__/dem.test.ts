import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { demEncrypt, demDecrypt, DEM_FIELDS } from "../crypto/dem.js";

// Shared note-format KAT fixture (byte-identical to Noir shared/src/common/dem.nr dem_kat_encrypt_decrypt).
const CEK = new Fr(
  0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bdan,
);

const PLAINTEXT: Fr[] = [
  new Fr(1n),
  new Fr(0x1234567890123456789012345678901234567890n),
  new Fr(0n),
  new Fr(0n),
  new Fr(100n),
  new Fr(0x2874ae964d8b283e2f521a7f14125fc92747bb9770139b8d4b70ee09e2d83785n),
  new Fr(0n),
];

// regenerated for kakure.* domains (ENC_DOMAIN moved)
const EXPECTED_CT: Fr[] = [
  new Fr(0x024f79539849d002c0148ca38583eb1d0b61e85739995df0d72d83ca2ca69350n),
  new Fr(0x1f151500c11f2f26d09d61914b53fa46cfc86ca56e12f8ee1a1ccf9f593f2461n),
  new Fr(0x19aef4d2384f4f02d2086e7a4a67bc0d46ae485411ee1250668930d93fd5255bn),
  new Fr(0x1b1b087d9957ceab0fdf063145bc05d5725db0ea2baaf360dea78ca8d9091b83n),
  new Fr(0x2412db8aed74c96d0e99ce8d91e3608b576fdcdee6e47e9388b51c64fb60a082n),
  new Fr(0x0dec6f4f28629a9dffa1a5891978592075ef6419a6d07fd3ff0dfdbc687f3204n),
  new Fr(0x13257c3200ac706a574cf25984a9a77a8eb06790e09281b728df6de05a8a52e0n),
];

describe("zero-AES Poseidon2 stream DEM (parity)", () => {
  it("encrypt matches the checked-in ciphertext KAT", async () => {
    const ciphertext = await demEncrypt(CEK, PLAINTEXT);
    expect(ciphertext.length).toBe(DEM_FIELDS);
    for (let k = 0; k < DEM_FIELDS; k++) {
      expect(ciphertext[k].equals(EXPECTED_CT[k])).toBe(true);
    }
  });

  it("decrypt of the ciphertext KAT round-trips to the plaintext", async () => {
    const recovered = await demDecrypt(CEK, EXPECTED_CT);
    expect(recovered.length).toBe(DEM_FIELDS);
    for (let k = 0; k < DEM_FIELDS; k++) {
      expect(recovered[k].equals(PLAINTEXT[k])).toBe(true);
    }
  });

  it("encrypt then decrypt is the identity", async () => {
    const recovered = await demDecrypt(CEK, await demEncrypt(CEK, PLAINTEXT));
    for (let k = 0; k < DEM_FIELDS; k++) {
      expect(recovered[k].equals(PLAINTEXT[k])).toBe(true);
    }
  });

  it("rejects a field array of the wrong length", async () => {
    await expect(demEncrypt(CEK, PLAINTEXT.slice(0, 6))).rejects.toThrow();
    await expect(
      demDecrypt(CEK, EXPECTED_CT.concat(new Fr(0n))),
    ).rejects.toThrow();
  });
});
