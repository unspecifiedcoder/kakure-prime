import type { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";

// Spec §3.2 / master plan global constraints: asset_id = first 20 bytes of
// sha256("kakure.asset.v1" || mint_pubkey), big-endian. Circuits already assert asset_id fits 20 bytes.
const ASSET_DOMAIN = new TextEncoder().encode("kakure.asset.v1");

/** `Asset` PDA seeds (I-2) key off this 20-byte id, not the mint directly, so a second mint colliding on
 *  the same id is rejected on-chain (`AssetCollision`) rather than silently sharing a vault. */
export function assetId(mint: PublicKey): Uint8Array {
  const input = new Uint8Array(ASSET_DOMAIN.length + 32);
  input.set(ASSET_DOMAIN, 0);
  input.set(mint.toBytes(), ASSET_DOMAIN.length);
  return sha256(input).slice(0, 20);
}
