import { PublicKey } from "@solana/web3.js";

/**
 * PDA seed derivations, byte-identical to master plan I-2:
 *   Pool       [b"pool"]
 *   Asset      [b"asset", asset_id: [u8;20]]
 *   Nullifier  [b"nullifier", nullifier: [u8;32]]
 */

export function poolPda(programId: PublicKey): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool")], programId);
}

export function assetPda(
  programId: PublicKey,
  assetIdBytes: Uint8Array,
): readonly [PublicKey, number] {
  if (assetIdBytes.length !== 20) {
    throw new Error(`assetPda: asset_id must be 20 bytes, got ${assetIdBytes.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset"), Buffer.from(assetIdBytes)],
    programId,
  );
}

export function nullifierPda(
  programId: PublicKey,
  nullifierBytes: Uint8Array,
): readonly [PublicKey, number] {
  if (nullifierBytes.length !== 32) {
    throw new Error(
      `nullifierPda: nullifier must be 32 bytes, got ${nullifierBytes.length}`,
    );
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), Buffer.from(nullifierBytes)],
    programId,
  );
}

/** The BPF Upgradeable Loader's well-known address. */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * F9 fix: `initialize` (`processor.rs`) now requires `authority` to equal the
 * deployed program's upgrade authority, read from its `ProgramData` account
 * (standard BPF Upgradeable Loader derivation: `[program_id]` under the
 * upgradeable loader program id) rather than trusting whichever signer lands
 * `Initialize` first.
 */
export function programDataAddress(programId: PublicKey): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID);
}
