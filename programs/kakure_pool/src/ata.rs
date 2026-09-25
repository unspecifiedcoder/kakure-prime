//! Minimal hand-rolled Associated Token Account helpers.
//!
//! Deliberately not a dependency on `spl-associated-token-account`/
//! `-interface`: that crate requests `solana-pubkey`'s `curve25519` feature,
//! which pulls curve25519-dalek -> a `zeroize`/`constant_time_eq` chain
//! whose latest releases require Cargo's `edition2024` feature -- and every
//! older release we tried pinning to needed the next-oldest dependency
//! pinned too (a fragile, ever-growing chain). `Pubkey::find_program_address`
//! from plain `solana-program` has a pure-software off-curve check with no
//! such dependency, and the ATA `Create` instruction wire format is a fixed,
//! tiny, publicly documented layout, so both are reproduced directly here.

use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_program::system_program::ID as SYSTEM_PROGRAM_ID;

/// The Associated Token Account program's well-known address.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub fn get_associated_token_address(wallet: &Pubkey, mint: &Pubkey, token_program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program_id.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// The ATA program's `Create` instruction (discriminant 0): creates the ATA
/// for `wallet`/`mint`/`token_program_id`, funded by `payer`.
pub fn create_associated_token_account(
    payer: &Pubkey,
    wallet: &Pubkey,
    mint: &Pubkey,
    token_program_id: &Pubkey,
) -> Instruction {
    let ata = get_associated_token_address(wallet, mint, token_program_id);
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(*token_program_id, false),
        ],
        data: vec![0u8],
    }
}
