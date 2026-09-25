use crate::state::{ASSET_SEED, NULLIFIER_SEED, POOL_SEED};
use solana_program::pubkey::Pubkey;

pub fn pool_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_SEED], program_id)
}

pub fn asset_pda(program_id: &Pubkey, asset_id: &[u8; 20]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ASSET_SEED, asset_id], program_id)
}

pub fn nullifier_pda(program_id: &Pubkey, nullifier: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[NULLIFIER_SEED, nullifier], program_id)
}
