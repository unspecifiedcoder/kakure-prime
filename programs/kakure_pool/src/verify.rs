//! `decompress_proof`: rebuilds the uncompressed 388-byte Groth16 proof
//! layout Sunspot's `verifier-bin` expects (see
//! `/root/sunspot/gnark-solana/crates/verifier-bin/src/lib.rs`) from the
//! 192-byte compressed wire format every proof-carrying `PoolInstruction`
//! now carries (workstream G, see `instruction.rs`'s module docs):
//! `A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ commitment_pok(32)` ->
//! `A(64) ‖ B(128) ‖ C(64) ‖ commitment_count:u32be=1 ‖ commitment(64) ‖
//! commitment_pok(64)`, using `solana_bn254`'s big-endian decompression
//! syscalls (`alt_bn128_g1_decompress`/`alt_bn128_g2_decompress`).
//!
//! `verify_cpi`: builds the `proof ‖ public_witness` instruction data used by
//! Sunspot's `verifier-bin` and invokes `pool.verifiers[circuit_id]` by CPI
//! (`invoke(&ix, &infos)`, its error passed straight through -- there is
//! nothing to map: Solana's runtime aborts the whole transaction with the
//! *callee's* error the instant a CPI fails, and code after a failing
//! `invoke()` never runs, so a caller can never catch and remap a failed
//! CPI's error). `PoolError::InvalidProof` is therefore aspirational for
//! CPI-level rejections: what actually surfaces on-chain there is the
//! verifier program's own error code, never `InvalidProof`. `InvalidProof`
//! IS surfaced directly, though, for a proof that fails to *decompress*
//! (`decompress_proof` below) -- that never reaches the CPI at all.
//!
//! Public-witness format matches gnark's own serialization exactly (see
//! `circuits/README.md`'s ".pw (public witness) byte layout" section and
//! `gnark-solana/crates/verifier-lib/src/witness.rs`'s `GnarkWitness`): a
//! 12-byte header (`nr_public_inputs`, `nr_private_inputs` (always 0 here),
//! `entries_count`, each a big-endian `u32`) followed by the 32-byte
//! big-endian field entries, in order.

use crate::error::PoolError;
use solana_bn254::compression::prelude::{alt_bn128_g1_decompress, alt_bn128_g2_decompress};
use solana_program::account_info::AccountInfo;
use solana_program::program::invoke;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// Compressed proof wire size: `A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ pok(32)`.
pub const COMPRESSED_PROOF_LEN: usize = 192;
/// Uncompressed proof wire size the verifier CPI expects: `A(64) ‖ B(128) ‖
/// C(64) ‖ commitment_count:u32be(4) ‖ commitment(64) ‖ pok(64)`.
pub const UNCOMPRESSED_PROOF_LEN: usize = 388;

/// Rebuilds the uncompressed 388-byte proof layout from the 192-byte
/// compressed wire format. Maps any decompression failure (a compressed
/// coordinate that is not a valid point on the curve, and not the
/// all-zero point-at-infinity encoding) to `PoolError::InvalidProof`.
pub fn decompress_proof(compressed: &[u8; COMPRESSED_PROOF_LEN]) -> Result<[u8; UNCOMPRESSED_PROOF_LEN], ProgramError> {
    // `solana_bn254`'s two build targets don't agree on argument shape --
    // the `target_os = "solana"` (on-chain syscall) implementations take a
    // fixed `&[u8; N]` for G2 but a `&[u8]` slice for G1, while the host
    // (`ark-bn254`-backed, used by tests running off-chain) implementations
    // take `&[u8]` for both. Slicing into fixed arrays here satisfies both.
    let a_c: [u8; 32] = compressed[0..32].try_into().unwrap();
    let b_c: [u8; 64] = compressed[32..96].try_into().unwrap();
    let c_c: [u8; 32] = compressed[96..128].try_into().unwrap();
    let commitment_c: [u8; 32] = compressed[128..160].try_into().unwrap();
    let pok_c: [u8; 32] = compressed[160..192].try_into().unwrap();

    let a = alt_bn128_g1_decompress(&a_c).map_err(|_| PoolError::InvalidProof)?;
    let b = alt_bn128_g2_decompress(&b_c).map_err(|_| PoolError::InvalidProof)?;
    let c = alt_bn128_g1_decompress(&c_c).map_err(|_| PoolError::InvalidProof)?;
    let commitment = alt_bn128_g1_decompress(&commitment_c).map_err(|_| PoolError::InvalidProof)?;
    let pok = alt_bn128_g1_decompress(&pok_c).map_err(|_| PoolError::InvalidProof)?;

    let mut out = [0u8; UNCOMPRESSED_PROOF_LEN];
    out[0..64].copy_from_slice(&a);
    out[64..192].copy_from_slice(&b);
    out[192..256].copy_from_slice(&c);
    out[256..260].copy_from_slice(&1u32.to_be_bytes()); // commitment_count
    out[260..324].copy_from_slice(&commitment);
    out[324..388].copy_from_slice(&pok);
    Ok(out)
}

pub fn verify_cpi<'a>(
    verifier_program: &AccountInfo<'a>,
    verifier_key: &Pubkey,
    proof: &[u8],
    public_inputs: &[[u8; 32]],
    remaining_accounts: &[AccountInfo<'a>],
) -> Result<(), ProgramError> {
    if verifier_program.key != verifier_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *verifier_key == Pubkey::default() {
        return Err(PoolError::VerifierUnset.into());
    }

    let n = public_inputs.len() as u32;
    let mut data = Vec::with_capacity(proof.len() + 12 + public_inputs.len() * 32);
    data.extend_from_slice(proof);
    data.extend_from_slice(&n.to_be_bytes()); // nr_public_inputs
    data.extend_from_slice(&0u32.to_be_bytes()); // nr_private_inputs
    data.extend_from_slice(&n.to_be_bytes()); // entries_count
    for input in public_inputs {
        data.extend_from_slice(input);
    }

    let ix = solana_program::instruction::Instruction {
        program_id: *verifier_key,
        accounts: vec![],
        data,
    };

    let mut infos = Vec::with_capacity(1 + remaining_accounts.len());
    infos.push(verifier_program.clone());
    infos.extend(remaining_accounts.iter().cloned());

    // slice-2 F-6: this used to be `.map_err(|_| PoolError::InvalidProof.into())`, but that map_err
    // is dead code -- a failing `invoke()` aborts the whole transaction with the CALLEE's error;
    // the caller's `Err(...)` branch here never runs (see this module's doc comment). Propagate the
    // real `ProgramError` (there normally isn't one to propagate, since a failure never returns)
    // rather than pretending we can remap it to `PoolError::InvalidProof`. (Independently found
    // and fixed the same way on `main` as review-slice-1 F7; this keeps the slice-2 comment.)
    invoke(&ix, &infos)
}
