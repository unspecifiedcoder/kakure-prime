import { Fr } from "@aztec/foundation/fields";
import { Poseidon } from "./Poseidon.js";

// Ported from the reference EVM implementation's wallets package/src/crypto/fields.ts, with the EVM-only `addressToFr` dropped
// (it depended on `ethers`' checksummed-address parsing; Kakure has no analogous on-chain address type —
// `solana/assetId.ts` and `solana/recipientField.ts` cover the equivalent Solana encodings instead).
export { Fr };

export function toFr(value: bigint | number | string): Fr {
  return new Fr(BigInt(value));
}

/** Right-aligns the UTF-8 bytes in 32 and Poseidon2-hashes; input must be <= 32 bytes. */
export async function stringToFr(text: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) {
    throw new Error(
      "stringToFr input string is too long, must be <= 32 bytes.",
    );
  }
  const paddedBytes = new Uint8Array(32);
  paddedBytes.set(bytes, 32 - bytes.length);
  const fieldFromBytes = Fr.fromBuffer(Buffer.from(paddedBytes));
  return await Poseidon.hash([fieldFromBytes]);
}

/** Wide-reduce mod BN254 Fr; for >32-byte inputs (seed, signature) that would otherwise throw. */
export function toReducedFr(value: bigint | number | string): Fr {
  return new Fr(BigInt(value) % Fr.MODULUS);
}
