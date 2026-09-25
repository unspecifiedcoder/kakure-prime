use crate::error::PoolError;
use crate::events::{
    emit_compliance_key_rotated, emit_note_inserted, emit_nullifier_spent, ComplianceKeyRotated,
    NoteInserted,
};
use crate::helpers::{asset_id_field, recipient_field};
use crate::instruction::PoolInstruction;
use crate::merkle;
use crate::pda::{asset_pda, nullifier_pda, pool_pda};
use crate::state::{Asset, Pool, ASSET_LEN, NULLIFIER_LEN, POOL_LEN};
use crate::verify::decompress_proof;

use borsh::BorshDeserialize;
use solana_program::account_info::{next_account_info, AccountInfo};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::entrypoint::ProgramResult;
use solana_program::program::{invoke, invoke_signed};
use solana_program::program_error::ProgramError;
use solana_program::program_pack::Pack;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::system_instruction;
use solana_program::sysvar::Sysvar;

/// Token and Token-2022 intentionally share the base mint layout and TransferChecked wire format.
/// Building this small interface instruction locally avoids pulling Token-2022's confidential
/// transfer dependency tree into the older Cargo toolchain used by `cargo build-sbf`.
fn token_program_supported(program: &Pubkey) -> bool {
    program == &spl_token::ID || program == &crate::TOKEN_2022_PROGRAM_ID
}

fn mint_decimals(mint: &AccountInfo, token_program: &Pubkey) -> Result<u8, ProgramError> {
    if mint.owner != token_program || !token_program_supported(token_program) {
        return Err(PoolError::UnsupportedMint.into());
    }
    let data = mint.try_borrow_data()?;
    // The base Mint layout is 82 bytes for both programs: decimals and initialized are offsets
    // 44 and 45. Token-2022 extension data follows that base section.
    if data.len() < spl_token::state::Mint::LEN || data[45] == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(data[44])
}

fn transfer_checked_ix(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Result<Instruction, ProgramError> {
    if !token_program_supported(token_program) {
        return Err(ProgramError::IncorrectProgramId);
    }
    // SPL Token instruction 12 is TransferChecked: u8 tag, little-endian u64 amount, u8 decimals.
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Ok(Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    })
}

pub fn process<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    let ix = PoolInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        PoolInstruction::Initialize { compliance_pk_x, compliance_pk_y, verifiers, genesis_leaf } => {
            initialize(program_id, accounts, compliance_pk_x, compliance_pk_y, verifiers, genesis_leaf)
        }
        PoolInstruction::SetVerifier { circuit_id, program } => set_verifier(program_id, accounts, circuit_id, program),
        PoolInstruction::RotateComplianceKey { x, y } => rotate_compliance_key(program_id, accounts, x, y),
        PoolInstruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
        PoolInstruction::Deposit { proof, public_inputs, amount } => {
            deposit(program_id, accounts, &proof, &public_inputs, amount)
        }
        PoolInstruction::Transfer { proof, public_inputs, root_index } => {
            transfer_like(program_id, accounts, &proof, &public_inputs, root_index, 1, 21)
        }
        PoolInstruction::TransferMultisig { proof, public_inputs, root_index } => {
            transfer_like(program_id, accounts, &proof, &public_inputs, root_index, 3, 21)
        }
        PoolInstruction::SplitMultisig { proof, public_inputs, root_index } => {
            split_multisig(program_id, accounts, &proof, &public_inputs, root_index)
        }
        PoolInstruction::JoinMultisig { proof, public_inputs, root_index } => {
            join_multisig(program_id, accounts, &proof, &public_inputs, root_index)
        }
        PoolInstruction::Withdraw { proof, public_inputs, amount, root_index } => {
            withdraw_like(program_id, accounts, &proof, &public_inputs, amount, root_index, 2)
        }
        PoolInstruction::WithdrawMultisig { proof, public_inputs, amount, root_index } => {
            withdraw_like(program_id, accounts, &proof, &public_inputs, amount, root_index, 6)
        }
        #[cfg(feature = "dev-verify")]
        PoolInstruction::VerifyOnly { circuit_id, proof, public_inputs } => {
            verify_only(accounts, circuit_id, &proof, &public_inputs)
        }
        #[cfg(not(feature = "dev-verify"))]
        PoolInstruction::VerifyOnly { .. } => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    compliance_pk_x: [u8; 32],
    compliance_pk_y: [u8; 32],
    verifiers: [Pubkey; 7],
    genesis_leaf: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let program_data_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // F9 fix: `initialize` used to be first-come -- whichever signer landed
    // the instruction first became `authority`, with no relation to who
    // actually deployed the program. Require `authority` to equal the
    // deployed program's OWN upgrade authority (read from its `ProgramData`
    // account) instead.
    require_upgrade_authority(program_id, authority.key, program_data_ai)?;

    let (expected_pool, bump) = pool_pda(program_id);
    if pool_ai.key != &expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }
    // F3 fix: init-if-needed, same as the nullifier/asset PDAs -- see
    // `create_pda_if_needed`'s doc comment.
    create_pda_if_needed(
        program_id,
        authority,
        pool_ai,
        system_program_ai,
        POOL_LEN,
        &[crate::state::POOL_SEED, &[bump]],
    )?;

    let mut data = pool_ai.try_borrow_mut_data()?;
    let mut pool = Pool::new(&mut data)?;
    pool.set_authority(authority.key);
    pool.set_paused(false);
    pool.set_compliance_version(0);
    pool.set_compliance_pk(&compliance_pk_x, &compliance_pk_y);
    pool.set_all_verifiers(&verifiers);
    pool.set_next_leaf_index(0);

    // Genesis leaf (spec I-5): computed off-chain by the client with
    // Poseidon2 (`genesisLeaf(genesis_hash_of_cluster)`); the program only
    // enforces the same "leaf 0 rejected" rule `merkle::insert` applies to
    // every leaf and inserts it as leaf 0.
    //
    // Bug fixed by workstream F (found running the real e2e scenario): this used to call the bare
    // `merkle::insert` instead of `insert_and_emit`, so the genesis leaf went into the on-chain
    // tree WITHOUT ever emitting a `NoteInserted` event. The indexer (E) has no other way to learn
    // about leaf 0 -- it builds its own tree mirror purely by observing events -- so its mirror's
    // leaf-index numbering was off by one from the pool's real on-chain numbering for every leaf
    // ever inserted after genesis (the first real deposit is on-chain leaf 1, but the indexer,
    // having never seen an event for leaf 0, numbered it leaf 0 in its own mirror). Every consumer
    // of the indexer's `/path/:leaf_index` and `/notes` endpoints -- ScanEngine, MultisigScanEngine,
    // the dashboard -- inherited this mismatch. Emitting a (ciphertext-less, since there is no real
    // note here) `NoteInserted` for the genesis leaf too makes leaf 0 observable like any other
    // leaf, with no special-casing required anywhere downstream.
    insert_and_emit(&mut pool, &genesis_leaf, [0u8; 32], None, None, [[0u8; 32]; 7])?;

    Ok(())
}

/// Dev/test only (see `PoolInstruction::VerifyOnly` and the `dev-verify`
/// feature): CPIs straight into `pool.verifiers[circuit_id]` with the exact
/// wire format `verify_cpi` uses, with no nullifier/root/leaf checks or
/// side effects. Lets a test exercise a real verifier binary without also
/// needing the pool's on-chain root/leaf state to match that proof's KAT
/// fixture. `public_inputs` here is the FULL, uninjected array (this ix
/// does no cpk/root splicing).
#[cfg(feature = "dev-verify")]
fn verify_only(accounts: &[AccountInfo], circuit_id: u8, proof: &[u8; 192], public_inputs: &[[u8; 32]]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let verifier_key = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let pool = Pool::new(&mut pool_data)?;
        if pool.authority() != *authority.key {
            return Err(ProgramError::InvalidAccountData);
        }
        pool.verifier(circuit_id)?
    };
    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, public_inputs, &remaining)
}

/// F4 fix: every handler that touches the pool account must verify it is
/// actually the program's pool PDA (and owned by this program), not merely
/// trust whatever address the caller placed at that account-list slot.
/// Previously only `initialize` and `withdraw_like` did this; a forged
/// program-owned account of the right length would otherwise pass every
/// other handler's checks (blocked today only by the runtime invariant that
/// this program never writes such an account elsewhere -- not by an
/// on-chain check).
fn expect_pool_pda(program_id: &Pubkey, pool_ai: &AccountInfo) -> Result<u8, ProgramError> {
    let (expected, bump) = pool_pda(program_id);
    if pool_ai.key != &expected || pool_ai.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

fn load_pool_authority<'a>(
    program_id: &Pubkey,
    accounts: &'a [AccountInfo<'a>],
) -> Result<(&'a AccountInfo<'a>, &'a AccountInfo<'a>), ProgramError> {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_pool_pda(program_id, pool_ai)?;
    Ok((authority, pool_ai))
}

fn set_verifier<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], circuit_id: u8, program: Pubkey) -> ProgramResult {
    let (authority, pool_ai) = load_pool_authority(program_id, accounts)?;
    let mut data = pool_ai.try_borrow_mut_data()?;
    let mut pool = Pool::new(&mut data)?;
    if pool.authority() != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    pool.set_verifier(circuit_id, &program)?;
    Ok(())
}

fn rotate_compliance_key<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], x: [u8; 32], y: [u8; 32]) -> ProgramResult {
    let (authority, pool_ai) = load_pool_authority(program_id, accounts)?;
    let mut data = pool_ai.try_borrow_mut_data()?;
    let mut pool = Pool::new(&mut data)?;
    if pool.authority() != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let old_version = pool.compliance_version();
    let new_version = old_version + 1;
    pool.set_compliance_pk(&x, &y);
    pool.set_compliance_version(new_version);
    emit_compliance_key_rotated(&ComplianceKeyRotated { old_version, new_version, x, y });
    Ok(())
}

fn set_paused<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], paused: bool) -> ProgramResult {
    let (authority, pool_ai) = load_pool_authority(program_id, accounts)?;
    let mut data = pool_ai.try_borrow_mut_data()?;
    let mut pool = Pool::new(&mut data)?;
    if pool.authority() != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    pool.set_paused(paused);
    Ok(())
}

// ---------------------------------------------------------------------------
// shared checks
// ---------------------------------------------------------------------------
//
// NOTE (workstream G): there used to be a `check_compliance` helper here
// comparing caller-supplied `cpk_x`/`cpk_y` public inputs against
// `pool.compliance_pk_x/y`. Since the wire format change, `cpk_x`/`cpk_y`
// are no longer client-supplied public inputs at all (for ANY
// proof-carrying ix, deposit included) -- the pool injects its own
// `compliance_pk_x()`/`compliance_pk_y()` directly into the public-input
// array it hands to the verifier CPI (see each handler below). There is
// nothing left to compare: a proof can only ever verify against the key
// the pool itself just injected, so the compliance binding is now
// implicit in the CPI itself rather than an explicit pre-check. The
// `PoolError::ComplianceKeyStale` variant is kept (not renumbered) even
// though nothing constructs it anymore.

/// F3 fix: `system_instruction::create_account` fails (`AccountAlreadyInUse`)
/// if the target address already has ANY lamports, even 0 bytes of data --
/// so anyone who knows a not-yet-created PDA's address in advance (the
/// nullifier and asset PDAs are both derivable off-chain; see the plan doc)
/// can send it 1 lamport and permanently brick that address for this
/// program. This helper gives PDA creation "init-if-needed" semantics: a
/// pre-funded-but-empty target is topped up to rent-exempt (rather than
/// treated as already-occupied) via transfer+allocate+assign instead of
/// create_account. A target that is already owned by this program, or that
/// has nonzero data, is rejected as already-initialized -- callers layer
/// their own domain-specific "already spent"/"collision" error on top where
/// that distinction matters (see `create_nullifier`).

/// The BPF Upgradeable Loader's well-known address, hardcoded rather than
/// pulled in via `solana_program::bpf_loader_upgradeable` (deprecated since
/// solana-program 2.3, re-exporting `solana-loader-v3-interface`, whose
/// `UpgradeableLoaderState` only implements (de)serialization behind a
/// `serde` feature this crate does not enable -- adding it risks reopening
/// the edition2024 dependency-chain dead end documented on this crate's
/// Cargo.toml). Same pattern as `ata::ASSOCIATED_TOKEN_PROGRAM_ID` and
/// `TOKEN_2022_PROGRAM_ID`.
pub const BPF_LOADER_UPGRADEABLE_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// F9 fix: requires `authority` to equal the calling program's own upgrade
/// authority, so `initialize` can only ever be landed by whoever controls
/// the program's upgrade key (or the deploy transaction itself, atomically)
/// -- not by whichever signer's `Initialize` transaction happens to land on
/// chain first.
///
/// `program_data_ai` must be the program's real `ProgramData` account
/// (`Pubkey::find_program_address(&[program_id], &BPF_LOADER_UPGRADEABLE_PROGRAM_ID)`);
/// this is checked, not merely assumed from the caller's account-list
/// position. Its data is `UpgradeableLoaderState::ProgramData`'s bincode
/// encoding, hand-parsed (see module doc above the `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`
/// constant for why): `variant:u32le(4) ‖ slot:u64le(8) ‖ has_authority:u8(1)
/// ‖ [authority:Pubkey(32) if has_authority]`. `ProgramData` is bincode enum
/// variant index 3 of `UpgradeableLoaderState`.
fn require_upgrade_authority(program_id: &Pubkey, authority: &Pubkey, program_data_ai: &AccountInfo) -> ProgramResult {
    const PROGRAM_DATA_VARIANT: u32 = 3; // UpgradeableLoaderState::ProgramData
    let (expected_program_data, _) =
        Pubkey::find_program_address(&[program_id.as_ref()], &BPF_LOADER_UPGRADEABLE_PROGRAM_ID);
    if program_data_ai.key != &expected_program_data {
        return Err(ProgramError::InvalidSeeds);
    }
    if program_data_ai.owner != &BPF_LOADER_UPGRADEABLE_PROGRAM_ID {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = program_data_ai.try_borrow_data()?;
    if data.len() < 4 + 8 + 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    let variant = u32::from_le_bytes(data[0..4].try_into().unwrap());
    if variant != PROGRAM_DATA_VARIANT {
        return Err(ProgramError::InvalidAccountData);
    }
    let has_authority = data[12];
    let upgrade_authority = match has_authority {
        0 => None,
        1 => {
            if data.len() < 13 + 32 {
                return Err(ProgramError::InvalidAccountData);
            }
            Some(Pubkey::try_from(&data[13..45]).unwrap())
        }
        _ => return Err(ProgramError::InvalidAccountData),
    };
    if upgrade_authority != Some(*authority) {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn create_pda_if_needed<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    if target.owner == program_id || !target.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let required = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    if have < required {
        invoke(
            &system_instruction::transfer(payer.key, target.key, required - have),
            &[payer.clone(), target.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(target.key, space as u64),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(target.key, program_id),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )?;
    Ok(())
}

fn resolve_root(pool: &Pool, root_index: u8) -> Result<[u8; 32], ProgramError> {
    let root = pool.root_at(root_index);
    if root == [0u8; 32] {
        return Err(PoolError::StaleRoot.into());
    }
    Ok(root)
}

fn check_count(public_inputs: &[[u8; 32]], expected: usize) -> Result<(), ProgramError> {
    if public_inputs.len() != expected {
        return Err(PoolError::InvalidPublicInputCount.into());
    }
    Ok(())
}

/// Creates the nullifier PDA with `init` semantics: fails atomically
/// (`NullifierSpent`) if the address is already funded/initialized.
fn create_nullifier<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    nullifier_ai: &AccountInfo<'a>,
    system_program_ai: &AccountInfo<'a>,
    nullifier: &[u8; 32],
) -> ProgramResult {
    let (expected, bump) = nullifier_pda(program_id, nullifier);
    if nullifier_ai.key != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    // F3 fix: only a program-owned (i.e. previously created by this exact
    // path) nullifier address counts as spent. A pre-funded-but-empty
    // address (the griefing attack the plan doc describes: anyone who can
    // compute a victim's future nullifier sends it 1 lamport) must NOT be
    // treated as spent -- `create_pda_if_needed` tops it up to rent-exempt
    // and takes ownership instead of failing.
    if nullifier_ai.owner == program_id {
        return Err(PoolError::NullifierSpent.into());
    }
    create_pda_if_needed(
        program_id,
        payer,
        nullifier_ai,
        system_program_ai,
        NULLIFIER_LEN,
        &[crate::state::NULLIFIER_SEED, nullifier, &[bump]],
    )?;
    nullifier_ai.try_borrow_mut_data()?[0] = bump;
    emit_nullifier_spent(*nullifier);
    Ok(())
}

fn insert_and_emit(
    pool: &mut Pool,
    leaf: &[u8; 32],
    eph_pub_x: [u8; 32],
    tag: Option<[u8; 32]>,
    cek_wrap: Option<[u8; 32]>,
    ciphertext: [[u8; 32]; 7],
) -> Result<(), ProgramError> {
    let (leaf_index, root) = merkle::insert(pool, leaf)?;
    emit_note_inserted(&NoteInserted { leaf_index, leaf: *leaf, eph_pub_x, tag, cek_wrap, ciphertext, root });
    Ok(())
}

fn ct7(inputs: &[[u8; 32]], start: usize) -> [[u8; 32]; 7] {
    let mut out = [[0u8; 32]; 7];
    out.copy_from_slice(&inputs[start..start + 7]);
    out
}

// ---------------------------------------------------------------------------
// deposit (circuit 0): 11 public inputs (no root); pool injects cpk_x/cpk_y
// at [0]/[1] before the CPI, giving the verifier the original 13-input
// array it was proven against.
// ---------------------------------------------------------------------------

fn deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof: &[u8; 192],
    public_inputs: &[[u8; 32]],
    amount: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let depositor = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let asset_ai = next_account_info(iter)?;
    let mint_ai = next_account_info(iter)?;
    let vault_ai = next_account_info(iter)?;
    let depositor_token_ai = next_account_info(iter)?;
    let token_program_ai = next_account_info(iter)?;
    let ata_program_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // F2 fix: pin the token program and ATA program to the real, well-known
    // programs. Without this an attacker-supplied `token_program` that
    // rubber-stamps `TransferChecked`/ATA-init CPIs lets `merkle::insert`
    // mint a note for the real mint's `asset_id` while no real tokens ever
    // move into the (attacker-owned) "vault" -- the note is later redeemable
    // against the REAL vault via a genuine withdraw. `ata_program_ai` is
    // checked too even though `invoke` below already hardcodes the real ATA
    // program id in the built instruction (defense in depth / clarity).
    if !token_program_supported(token_program_ai.key) {
        return Err(PoolError::UnsupportedMint.into());
    }
    if ata_program_ai.key != &crate::ata::ASSOCIATED_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    check_count(public_inputs, 11)?;

    // Pin the mint owner to the exact token program account passed to every CPI. This keeps the
    // original substitution defense while allowing Token-2022 equities such as xStocks.
    if mint_ai.owner != token_program_ai.key {
        return Err(PoolError::UnsupportedMint.into());
    }

    let leaf = public_inputs[0];
    let eph_pub_x = public_inputs[1];
    let value_field = public_inputs[2];
    let asset_id_input = public_inputs[3];

    let mut amount_field = [0u8; 32];
    amount_field[24..32].copy_from_slice(&amount.to_be_bytes());
    if value_field != amount_field {
        return Err(PoolError::AmountMismatch.into());
    }
    if asset_id_input != asset_id_field(mint_ai.key) {
        return Err(PoolError::AssetMismatch.into());
    }

    // Scoped: `pool_ai`'s data must not still be borrowed when the ATA-create
    // CPI below runs, since that CPI passes `pool_ai` (as the vault's owner)
    // in its own account list -- the runtime rejects a CPI touching an
    // account this program still holds a live Rust borrow on
    // ("AccountBorrowFailed").
    //
    // F-4 fix (workstream L, log-truncation root cause): `insert_and_emit`
    // (the `NoteInserted` `sol_log_data` line) now runs HERE, before the
    // verifier CPI, instead of after every other CPI in this handler. Sound
    // because Solana transactions are all-or-nothing: if the verifier CPI
    // (or anything after it) fails, the ENTIRE transaction -- including this
    // insert's state mutation and its log line -- is rolled back and never
    // lands on chain, so the indexer never sees it (see
    // `packages/indexer/src/ingest/ingest.ts::processSignature`'s
    // `tx.err` skip). Moving the emit earlier protects it from a different
    // failure mode: a REAL (non-mock) verifier CPI can itself emit enough of
    // its own `Program log:` output to approach Solana's per-transaction log
    // budget, silently truncating any log line emitted AFTER it -- including
    // this one, in the old ordering. Emitting first means truncation (if it
    // happens at all) can only hit logs this program doesn't rely on being
    // indexed.
    let (verifier_key, full_inputs) = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let mut pool = Pool::new(&mut pool_data)?;
        if pool.paused() {
            return Err(PoolError::Paused.into());
        }
        let mut full = Vec::with_capacity(13);
        full.push(pool.compliance_pk_x());
        full.push(pool.compliance_pk_y());
        full.extend_from_slice(public_inputs);
        let verifier_key = pool.verifier(0)?;
        insert_and_emit(&mut pool, &leaf, eph_pub_x, None, None, ct7(public_inputs, 4))?;
        (verifier_key, full)
    };
    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, &full_inputs, &remaining)?;

    // Asset registry: create on first deposit, else assert no collision.
    let asset_id_bytes20 = crate::helpers::asset_id_bytes(mint_ai.key);
    let (expected_asset, asset_bump) = asset_pda(program_id, &asset_id_bytes20);
    if asset_ai.key != &expected_asset {
        return Err(ProgramError::InvalidSeeds);
    }
    let expected_vault = crate::ata::get_associated_token_address(pool_ai.key, mint_ai.key, token_program_ai.key);
    if vault_ai.key != &expected_vault {
        return Err(ProgramError::InvalidSeeds);
    }

    if asset_ai.data_is_empty() {
        // F3 fix: init-if-needed. A pre-funded (1 lamport, empty-data) asset
        // PDA must not permanently block the first deposit of that mint --
        // see `create_pda_if_needed`'s doc comment.
        create_pda_if_needed(
            program_id,
            depositor,
            asset_ai,
            system_program_ai,
            ASSET_LEN,
            &[crate::state::ASSET_SEED, &asset_id_bytes20, &[asset_bump]],
        )?;
        let mut adata = asset_ai.try_borrow_mut_data()?;
        let mut asset = Asset::new(&mut adata)?;
        asset.write(mint_ai.key, vault_ai.key, &asset_id_bytes20, asset_bump);
    } else {
        let mut adata = asset_ai.try_borrow_mut_data()?;
        let asset = Asset::new(&mut adata)?;
        if asset.mint() != *mint_ai.key {
            return Err(PoolError::AssetCollision.into());
        }
        // F2 fix: the vault passed in this ix must be the SAME vault the
        // asset was registered with on its first deposit -- otherwise a
        // second deposit could target a different (attacker-controlled)
        // "vault" address for an asset_id that already has real backing.
        if asset.vault() != *vault_ai.key {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    if vault_ai.data_is_empty() {
        invoke(
            &crate::ata::create_associated_token_account(
                depositor.key,
                pool_ai.key,
                mint_ai.key,
                token_program_ai.key,
            ),
            &[
                depositor.clone(),
                vault_ai.clone(),
                pool_ai.clone(),
                mint_ai.clone(),
                system_program_ai.clone(),
                token_program_ai.clone(),
                ata_program_ai.clone(),
            ],
        )?;
    }

    let mint_decimals = mint_decimals(mint_ai, token_program_ai.key)?;
    invoke(
        &transfer_checked_ix(
            token_program_ai.key,
            depositor_token_ai.key,
            mint_ai.key,
            vault_ai.key,
            depositor.key,
            &[],
            amount,
            mint_decimals,
        )?,
        &[
            depositor_token_ai.clone(),
            mint_ai.clone(),
            vault_ai.clone(),
            depositor.clone(),
            token_program_ai.clone(),
        ],
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// transfer / transfer_multisig (circuits 1, 3): 21 public inputs, one root
// (via root_index). Original I-1 array is [cpk_x, cpk_y, nullifier, root,
// memo_leaf, memo_eph_x, memo_tag, memo_cek_wrap, memo_ct0..6, change_leaf,
// change_eph_x, change_ct0..6] (24); wire `public_inputs` drops cpk_x/cpk_y
// and root, i.e. [nullifier, memo_leaf, ..., change_ct6] (21).
// ---------------------------------------------------------------------------

fn transfer_like(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof: &[u8; 192],
    public_inputs: &[[u8; 32]],
    root_index: u8,
    circuit_id: u8,
    expected_count: usize,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let nullifier_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_pool_pda(program_id, pool_ai)?;
    check_count(public_inputs, expected_count)?;

    let nullifier = public_inputs[0];
    let memo_leaf = public_inputs[1];
    let memo_eph_x = public_inputs[2];
    let memo_tag = public_inputs[3];
    let memo_cek_wrap = public_inputs[4];
    let memo_ct = ct7(public_inputs, 5);
    let change_leaf = public_inputs[12];
    let change_eph_x = public_inputs[13];
    let change_ct = ct7(public_inputs, 14);

    // F-4 fix (workstream L): `create_nullifier` (the `NullifierSpent` line)
    // and both `insert_and_emit`s (`NoteInserted`) now run in this same
    // pre-CPI borrow, before the verifier CPI, instead of after it -- see
    // `deposit`'s doc comment above for why this is sound and what problem
    // it fixes (a real verifier's own CPI log volume was truncating these
    // lines out of the transaction's log buffer before the indexer could
    // ever see them).
    let (verifier_key, full_inputs) = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let mut pool = Pool::new(&mut pool_data)?;
        if pool.paused() {
            return Err(PoolError::Paused.into());
        }
        let root = resolve_root(&pool, root_index)?;
        let mut full = Vec::with_capacity(24);
        full.push(pool.compliance_pk_x());
        full.push(pool.compliance_pk_y());
        full.push(nullifier);
        full.push(root);
        full.extend_from_slice(&public_inputs[1..]);
        let verifier_key = pool.verifier(circuit_id)?;
        insert_and_emit(&mut pool, &memo_leaf, memo_eph_x, Some(memo_tag), Some(memo_cek_wrap), memo_ct)?;
        insert_and_emit(&mut pool, &change_leaf, change_eph_x, None, None, change_ct)?;
        (verifier_key, full)
    };
    create_nullifier(program_id, payer, nullifier_ai, system_program_ai, &nullifier)?;

    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, &full_inputs, &remaining)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// split_multisig (circuit 4): 19 public inputs, one root, two output
// leaves, one nullifier. Original array: [cpk_x, cpk_y, nullifier, root,
// out1_leaf, out1_eph_x, out1_ct0..6, out2_leaf, out2_eph_x, out2_ct0..6]
// (22); wire drops cpk_x/cpk_y/root -> [nullifier, out1_leaf, ..., out2_ct6]
// (19).
// ---------------------------------------------------------------------------

fn split_multisig(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof: &[u8; 192],
    public_inputs: &[[u8; 32]],
    root_index: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let nullifier_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_pool_pda(program_id, pool_ai)?;
    check_count(public_inputs, 19)?;

    let nullifier = public_inputs[0];
    let out1_leaf = public_inputs[1];
    let out1_eph_x = public_inputs[2];
    let out1_ct = ct7(public_inputs, 3);
    let out2_leaf = public_inputs[10];
    let out2_eph_x = public_inputs[11];
    let out2_ct = ct7(public_inputs, 12);

    // F-4 fix (workstream L): see `transfer_like`'s doc comment above.
    let (verifier_key, full_inputs) = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let mut pool = Pool::new(&mut pool_data)?;
        if pool.paused() {
            return Err(PoolError::Paused.into());
        }
        let root = resolve_root(&pool, root_index)?;
        let mut full = Vec::with_capacity(22);
        full.push(pool.compliance_pk_x());
        full.push(pool.compliance_pk_y());
        full.push(nullifier);
        full.push(root);
        full.extend_from_slice(&public_inputs[1..]);
        let verifier_key = pool.verifier(4)?;
        insert_and_emit(&mut pool, &out1_leaf, out1_eph_x, None, None, out1_ct)?;
        insert_and_emit(&mut pool, &out2_leaf, out2_eph_x, None, None, out2_ct)?;
        (verifier_key, full)
    };
    create_nullifier(program_id, payer, nullifier_ai, system_program_ai, &nullifier)?;

    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, &full_inputs, &remaining)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// join_multisig (circuit 5): 11 public inputs, one root (at original I-1
// index 4), two nullifiers, one output leaf. Original array: [cpk_x, cpk_y,
// nullifier_a, nullifier_b, root, out_leaf, out_eph_x, out_ct0..6] (14);
// wire drops cpk_x/cpk_y/root -> [nullifier_a, nullifier_b, out_leaf,
// out_eph_x, out_ct0..6] (11).
// ---------------------------------------------------------------------------

fn join_multisig(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof: &[u8; 192],
    public_inputs: &[[u8; 32]],
    root_index: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let nullifier_a_ai = next_account_info(iter)?;
    let nullifier_b_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_pool_pda(program_id, pool_ai)?;
    check_count(public_inputs, 11)?;

    let nullifier_a = public_inputs[0];
    let nullifier_b = public_inputs[1];
    let out_leaf = public_inputs[2];
    let out_eph_x = public_inputs[3];
    let out_ct = ct7(public_inputs, 4);

    // F-4 fix (workstream L): see `transfer_like`'s doc comment above.
    let (verifier_key, full_inputs) = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let mut pool = Pool::new(&mut pool_data)?;
        if pool.paused() {
            return Err(PoolError::Paused.into());
        }
        let root = resolve_root(&pool, root_index)?;
        let mut full = Vec::with_capacity(14);
        full.push(pool.compliance_pk_x());
        full.push(pool.compliance_pk_y());
        full.push(nullifier_a);
        full.push(nullifier_b);
        full.push(root);
        full.extend_from_slice(&public_inputs[2..]);
        let verifier_key = pool.verifier(5)?;
        insert_and_emit(&mut pool, &out_leaf, out_eph_x, None, None, out_ct)?;
        (verifier_key, full)
    };
    create_nullifier(program_id, payer, nullifier_a_ai, system_program_ai, &nullifier_a)?;
    create_nullifier(program_id, payer, nullifier_b_ai, system_program_ai, &nullifier_b)?;

    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, &full_inputs, &remaining)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// withdraw / withdraw_multisig (circuits 2, 6): 14 public inputs, one root.
// Original array: [value, recipient, intent_hash, cpk_x, cpk_y, nullifier,
// root, asset_id, change_leaf, change_eph_x, change_ct0..6] (17); wire
// drops cpk_x/cpk_y/root -> [value, recipient, intent_hash, nullifier,
// asset_id, change_leaf, change_eph_x, change_ct0..6] (14).
// ---------------------------------------------------------------------------

fn withdraw_like(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof: &[u8; 192],
    public_inputs: &[[u8; 32]],
    amount: u64,
    root_index: u8,
    circuit_id: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let pool_ai = next_account_info(iter)?;
    let nullifier_ai = next_account_info(iter)?;
    let asset_ai = next_account_info(iter)?;
    let mint_ai = next_account_info(iter)?;
    let vault_ai = next_account_info(iter)?;
    let destination_ai = next_account_info(iter)?;
    let token_program_ai = next_account_info(iter)?;
    let system_program_ai = next_account_info(iter)?;
    let verifier_ai = next_account_info(iter)?;
    let remaining: Vec<AccountInfo> = iter.cloned().collect();

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // F2 fix (self-harm only here: the real vault can only be moved by the
    // real token program, since it is owned by `spl_token::ID`; pinned
    // anyway for symmetry with `deposit` and defense in depth).
    if !token_program_supported(token_program_ai.key) || mint_ai.owner != token_program_ai.key {
        return Err(ProgramError::IncorrectProgramId);
    }
    check_count(public_inputs, 14)?;

    let bump = expect_pool_pda(program_id, pool_ai)?;

    let withdraw_value = public_inputs[0];
    let recipient = public_inputs[1];
    let intent_hash = public_inputs[2];
    let nullifier = public_inputs[3];
    let asset_id_input = public_inputs[4];
    let change_leaf = public_inputs[5];
    let change_eph_x = public_inputs[6];
    let change_ct = ct7(public_inputs, 7);

    if intent_hash != [0u8; 32] {
        return Err(PoolError::IntentHashNotZero.into());
    }
    let mut amount_field = [0u8; 32];
    amount_field[24..32].copy_from_slice(&amount.to_be_bytes());
    if withdraw_value != amount_field {
        return Err(PoolError::AmountMismatch.into());
    }
    if recipient != recipient_field(destination_ai.key) {
        return Err(PoolError::RecipientMismatch.into());
    }

    {
        let mut adata = asset_ai.try_borrow_mut_data()?;
        let asset = Asset::new(&mut adata)?;
        if asset.mint() != *mint_ai.key {
            return Err(PoolError::AssetMismatch.into());
        }
        let expected_asset_field = asset_id_field(mint_ai.key);
        if asset_id_input != expected_asset_field {
            return Err(PoolError::AssetMismatch.into());
        }
        if asset.vault() != *vault_ai.key {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    // Scoped: `pool_ai`'s data must not still be borrowed when the
    // pool-PDA-signed transfer_checked CPI below runs, since that CPI
    // passes `pool_ai` (as the vault's authority) in its own account list.
    //
    // F-4 fix (workstream L): `insert_and_emit` (`NoteInserted`) now runs in
    // this same pre-CPI borrow, and `create_nullifier` (`NullifierSpent`)
    // right after it, both before the verifier CPI -- see `deposit`'s doc
    // comment above for why. The actual token payout
    // (`transfer_checked` below) is deliberately left AFTER the CPI,
    // unchanged: moving state mutations earlier is safe for the SAME reason
    // it is safe for the events (a failing CPI reverts the whole
    // transaction), but there is no log-truncation reason to move it, and
    // keeping it gated on a verified proof is the more conservative choice.
    let (verifier_key, full_inputs) = {
        let mut pool_data = pool_ai.try_borrow_mut_data()?;
        let mut pool = Pool::new(&mut pool_data)?;
        if pool.paused() {
            return Err(PoolError::Paused.into());
        }
        let root = resolve_root(&pool, root_index)?;
        let mut full = Vec::with_capacity(17);
        full.push(withdraw_value);
        full.push(recipient);
        full.push(intent_hash);
        full.push(pool.compliance_pk_x());
        full.push(pool.compliance_pk_y());
        full.push(nullifier);
        full.push(root);
        full.extend_from_slice(&public_inputs[4..]);
        let verifier_key = pool.verifier(circuit_id)?;
        insert_and_emit(&mut pool, &change_leaf, change_eph_x, None, None, change_ct)?;
        (verifier_key, full)
    };
    create_nullifier(program_id, payer, nullifier_ai, system_program_ai, &nullifier)?;

    let uncompressed = decompress_proof(proof)?;
    crate::verify::verify_cpi(verifier_ai, &verifier_key, &uncompressed, &full_inputs, &remaining)?;

    let mint_decimals = mint_decimals(mint_ai, token_program_ai.key)?;
    invoke_signed(
        &transfer_checked_ix(
            token_program_ai.key,
            vault_ai.key,
            mint_ai.key,
            destination_ai.key,
            pool_ai.key,
            &[],
            amount,
            mint_decimals,
        )?,
        &[
            vault_ai.clone(),
            mint_ai.clone(),
            destination_ai.clone(),
            pool_ai.clone(),
            token_program_ai.clone(),
        ],
        &[&[crate::state::POOL_SEED, &[bump]]],
    )?;

    Ok(())
}
