//! Mock Groth16 verifier used by kakure_pool's litesvm test suite in place of
//! a real Sunspot-generated verifier program. Mirrors the CPI call shape of
//! `/root/sunspot/gnark-solana/crates/verifier-bin`: instruction data is
//! `proof_bytes ‖ public_witness_bytes` with no accounts required, where
//! `proof_bytes` is the UNCOMPRESSED 388-byte layout (kakure_pool decompresses
//! the 192-byte wire-format proof before this CPI -- see
//! `kakure_pool::verify::decompress_proof`).
//!
//! Workstream G wire-format change: this mock used to accept iff
//! `instruction_data[0] == 0x01` (the old, uncompressed proof's raw first
//! byte, fully caller-controlled). Now every proof byte this mock sees has
//! passed through real on-chain BN254 (de)compression first, so a
//! caller-chosen "marker" byte at a fixed offset no longer works in general
//! (an arbitrary byte value is not a valid curve-point encoding). Instead:
//! accept iff the decompressed `A` point (`instruction_data[0..64]`, the
//! first proof element) is NOT the all-zero point-at-infinity encoding.
//! `alt_bn128_g1_decompress` special-cases an all-zero 32-byte compressed
//! input as the identity (no curve check needed), so a "rejecting" fixture
//! can just be all-zero compressed bytes; an "accepting" fixture only needs
//! ONE genuine nonzero point (e.g. the BN254 G1 generator) for `A`, with
//! every other proof element left at the (always-decompressible) zero
//! encoding -- see `tests-litesvm/tests/common/mod.rs`'s `accepting_proof`/
//! `rejecting_proof`.
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let a_is_nonzero = instruction_data.len() >= 64 && instruction_data[0..64] != [0u8; 64];
    if a_is_nonzero {
        msg!("mock_verifier: proof accepted");
        Ok(())
    } else {
        msg!("mock_verifier: proof rejected");
        Err(ProgramError::InvalidInstructionData)
    }
}
