//! Domain-hash helpers (spec §3.2 / §3.3), computed on-chain with the
//! `sol_sha256` syscall via `solana_program::hash::hashv`.

use solana_program::hash::hashv;
use solana_program::pubkey::Pubkey;

pub const ASSET_ID_DOMAIN: &[u8] = b"kakure.asset.v1";
pub const RECIPIENT_DOMAIN: &[u8] = b"kakure.recipient.v1";

/// `asset_id = sha256("kakure.asset.v1" ‖ mint)[0..20]`, encoded as the
/// 32-byte big-endian field the circuits expect (top 12 bytes zero).
pub fn asset_id_bytes(mint: &Pubkey) -> [u8; 20] {
    let digest = hashv(&[ASSET_ID_DOMAIN, mint.as_ref()]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest.to_bytes()[0..20]);
    out
}

pub fn asset_id_field(mint: &Pubkey) -> [u8; 32] {
    let mut field = [0u8; 32];
    field[12..32].copy_from_slice(&asset_id_bytes(mint));
    field
}

/// `recipient_field = sha256("kakure.recipient.v1" ‖ destination_token_account)`
/// with byte 0 (most-significant, big-endian) zeroed so the value is
/// canonically < the BN254 scalar field.
pub fn recipient_field(destination_token_account: &Pubkey) -> [u8; 32] {
    let digest = hashv(&[RECIPIENT_DOMAIN, destination_token_account.as_ref()]);
    let mut out = digest.to_bytes();
    out[0] = 0;
    out
}
