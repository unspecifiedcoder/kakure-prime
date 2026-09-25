import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Poseidon } from "../crypto/Poseidon";
import { toFr } from "../crypto/fields";

// `addressToFr` (EVM checksummed-address parsing via `ethers`) was dropped along with `crypto/fields.ts`'s
// other EVM coupling per the master plan's SDK port rules; Kakure has no analogous on-chain address type
// (see `crypto/fields.ts`'s file comment and `solana/assetId.ts`/`solana/recipientField.ts` for the
// Solana-side replacements), so its test coverage below was dropped with it.
describe("Cryptographic Primitives", () => {
  describe("toFr", () => {
    it("should convert a bigint to an Fr element", () => {
      const fr = toFr(123n);
      expect(fr).toBeInstanceOf(Fr);
      expect(fr.toBigInt()).toBe(123n);
    });
  });

  describe("Poseidon", () => {
    it("should be deterministic", async () => {
      const input = [toFr(1), toFr(2), toFr(3)];
      const hash1 = await Poseidon.hash(input);
      const hash2 = await Poseidon.hash(input);
      expect(hash1.equals(hash2)).toBe(true);
    });

    it("should produce a different hash for different inputs", async () => {
      const input1 = [toFr(1), toFr(2)];
      const input2 = [toFr(2), toFr(1)];
      const hash1 = await Poseidon.hash(input1);
      const hash2 = await Poseidon.hash(input2);
      expect(hash1.equals(hash2)).toBe(false);
    });

    it("should produce a known hash output", async () => {
      const input = [toFr(1), toFr(2)];
      const expectedHash = new Fr(
        0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383n,
      );
      const actualHash = await Poseidon.hash(input);
      expect(actualHash.equals(expectedHash)).toBe(true);
    });

    it("should not collide on random inputs", async () => {
      const inputs = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const randBuffer = new Uint32Array(2);
        crypto.getRandomValues(randBuffer);
        const rand1 = toFr(
          (BigInt(randBuffer[0]) * BigInt(randBuffer[1])) % Fr.MODULUS,
        );
        const rand2 = toFr(BigInt(randBuffer[0]) + (BigInt(i) % Fr.MODULUS));
        const hash = await Poseidon.hash([rand1, rand2]);
        const hashStr = hash.toString();
        expect(inputs.has(hashStr)).toBe(false);
        inputs.add(hashStr);
      }
    });
  });
});
