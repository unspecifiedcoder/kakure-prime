//! `kakure_pool`: the Solana program holding the shielded-note commitment
//! tree, nullifier set, SPL vaults, compliance key and verifier registry.
//! See `docs/superpowers/plans/2026-09-05-ws-b-program.md` for the plan and
//! the workstream-B final report for deviations from the frozen interfaces
//! (I-1..I-5) in `docs/superpowers/plans/2026-09-05-kakure-master-plan.md`.

pub mod ata;
pub mod error;
pub mod events;
pub mod helpers;
pub mod instruction;
pub mod merkle;
pub mod pda;
pub mod processor;
pub mod state;
pub mod verify;

use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::pubkey::Pubkey;

/// The Token-2022 program's well-known address. The processor uses the shared base-mint and
/// TransferChecked interface directly so the SBF build does not inherit Token-2022's much larger
/// confidential-transfer dependency tree.
pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
