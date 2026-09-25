use kakure_pool::instruction::PoolInstruction;
use kakure_pool::pda::{asset_pda, nullifier_pda, pool_pda};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_transaction::Transaction;

/// `kakure_pool` depends on `solana-program` 2.x (see its Cargo.toml for
/// why) while this test harness's own `solana-sdk` pin (needed for litesvm
/// 0.16 compatibility) is 3.x -- two different, non-unified `Pubkey` types
/// with the same byte representation. These convert between them.
pub fn to_kp(p: &Pubkey) -> solana_program::pubkey::Pubkey {
    solana_program::pubkey::Pubkey::new_from_array(p.to_bytes())
}
pub fn from_kp(p: &solana_program::pubkey::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}

pub const KAKURE_POOL_ID: Pubkey = Pubkey::new_from_array([7u8; 32]);
pub const MOCK_VERIFIER_ID: Pubkey = Pubkey::new_from_array([9u8; 32]);

/// Loads both program .so's built by `cargo build-sbf` into a fresh LiteSVM.
///
/// Workstream G note: `LiteSVM::new()`'s default `FeatureSet` has EVERY
/// feature disabled (including `enable_alt_bn128_compression_syscall`), so
/// `sol_alt_bn128_compression` silently writes an all-zero result instead
/// of actually decompressing -- there is no error, just wrong output, which
/// made every proof/verify test decompress its `A`/`B`/`C`/commitment/pok
/// to all-zero and get rejected by `mock_verifier`. `with_mainnet_features`
/// activates the real (mainnet) feature set, including that syscall.
pub fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new().with_mainnet_features();
    // F8 fix: point at `programs/deploy/`, the artifact this repo actually
    // ships (and what `e2e/localnet.ts` genesis-loads) -- not
    // `../target/deploy`, a build output directory that may be stale, built
    // with a different feature set (e.g. `dev-verify`), or simply absent.
    // `just build-programs` (see `justfile`) rebuilds straight into
    // `programs/deploy/` for exactly this reason.
    let so_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../programs/deploy");
    svm.add_program_from_file(KAKURE_POOL_ID, so_dir.join("kakure_pool.so"))
        .expect("load kakure_pool.so (run `just build-programs` first)");
    svm.add_program_from_file(MOCK_VERIFIER_ID, so_dir.join("mock_verifier.so"))
        .expect("load mock_verifier.so (run `cargo build-sbf` first)");

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    (svm, payer)
}

/// `ComputeBudget111111111111111111111111111111`, `SetComputeUnitLimit`
/// (discriminant 2) requesting 1.4M CU -- matches what a real client
/// attaches per spec §4 ("clients attach a ComputeBudget ix requesting
/// 1.4M CU"). Needed for the real-verifier test (a real Groth16
/// verification costs far more than litesvm's 200k default budget); built
/// by hand rather than via a `solana-compute-budget-interface` dependency
/// since the wire format (one byte tag + little-endian u32) is tiny and
/// stable.
fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    use std::str::FromStr;
    Instruction {
        program_id: Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
        accounts: vec![],
        data,
    }
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    accounts: Vec<AccountMeta>,
    ix_data: PoolInstruction,
) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
    let ix = Instruction {
        program_id: KAKURE_POOL_ID,
        accounts,
        data: borsh::to_vec(&ix_data).unwrap(),
    };
    let mut all_signers = vec![payer];
    all_signers.extend(signers.iter().copied());
    let tx = Transaction::new_signed_with_payer(
        &[compute_budget_ix(1_400_000), ix],
        Some(&payer.pubkey()),
        &all_signers,
        svm.latest_blockhash(),
    );
    let meta = svm.send_transaction(tx)?;
    Ok(meta.compute_units_consumed)
}

/// Like `send`, but returns the full `TransactionMetadata` (including `logs`) instead of just the
/// CU count -- used to capture real log bracketing (`Program <id> invoke [n]` / `success` nesting)
/// for the indexer's `programDataLinesFor` regression test.
pub fn send_full(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    accounts: Vec<AccountMeta>,
    ix_data: PoolInstruction,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let ix = Instruction { program_id: KAKURE_POOL_ID, accounts, data: borsh::to_vec(&ix_data).unwrap() };
    let mut all_signers = vec![payer];
    all_signers.extend(signers.iter().copied());
    let tx = Transaction::new_signed_with_payer(
        &[compute_budget_ix(1_400_000), ix],
        Some(&payer.pubkey()),
        &all_signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// F9 fix (`processor.rs::require_upgrade_authority`): `initialize` now
/// needs the pool program's real `ProgramData` account. `litesvm` never runs
/// a real `bpf_loader_upgradeable` deploy for programs loaded via
/// `add_program_from_file`, so this forges one directly with `set_account`,
/// bincode-encoding `UpgradeableLoaderState::ProgramData { slot: 0,
/// upgrade_authority_address: Some(*upgrade_authority) }` by hand (variant
/// index 3, little-endian `u32`, then `slot:u64le`, then `Option<Pubkey>` as
/// a 1-byte tag followed by the 32 raw bytes when present) -- exactly the
/// layout `require_upgrade_authority` parses.
pub fn program_data_key() -> Pubkey {
    from_kp(&solana_program::pubkey::Pubkey::find_program_address(
        &[to_kp(&KAKURE_POOL_ID).as_ref()],
        &kakure_pool::processor::BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    ).0)
}

pub fn set_program_data_account(svm: &mut LiteSVM, upgrade_authority: &Pubkey) {
    let mut data = Vec::with_capacity(4 + 8 + 1 + 32);
    data.extend_from_slice(&3u32.to_le_bytes()); // ProgramData variant
    data.extend_from_slice(&0u64.to_le_bytes()); // slot
    data.push(1); // Option::Some
    data.extend_from_slice(upgrade_authority.as_ref());
    svm.set_account(
        program_data_key(),
        solana_account::Account {
            lamports: 1_000_000_000,
            data,
            owner: from_kp(&kakure_pool::processor::BPF_LOADER_UPGRADEABLE_PROGRAM_ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn pool_key() -> Pubkey {
    from_kp(&pool_pda(&to_kp(&KAKURE_POOL_ID)).0)
}
pub fn asset_key(asset_id: &[u8; 20]) -> Pubkey {
    from_kp(&asset_pda(&to_kp(&KAKURE_POOL_ID), asset_id).0)
}
pub fn nullifier_key(nullifier: &[u8; 32]) -> Pubkey {
    from_kp(&nullifier_pda(&to_kp(&KAKURE_POOL_ID), nullifier).0)
}

pub fn field_of_u64(v: u64) -> [u8; 32] {
    let mut f = [0u8; 32];
    f[24..32].copy_from_slice(&v.to_be_bytes());
    f
}

/// F3 tests (griefing-lamport pre-funding): the smallest amount a griefer can send a
/// not-yet-created PDA without the FUNDING transfer itself being rejected. `svm.airdrop` (like a
/// real wallet-to-PDA `system_instruction::transfer`) is itself a transaction subject to Solana's
/// rent-state-transition invariant under `with_mainnet_features()`: crediting a brand-new
/// (`Uninitialized`, 0 lamports) account with an amount that leaves it `RentPaying` (nonzero but
/// below the rent-exempt minimum for its size) is rejected with `InsufficientFundsForRent` --
/// exactly the same rule a real attacker hits funding a PDA with a literal 1 lamport on mainnet.
/// The realistic griefing amount is therefore "rent-exempt for an empty (0-byte) account" (~890k
/// lamports, ~0.00089 SOL -- still dirt cheap), not literally 1 lamport; `create_pda_if_needed`
/// tolerates this exactly the same way it would tolerate 1 lamport (its `have < required` top-up
/// logic does not care which nonzero starting balance it began from).
pub fn griefing_lamports() -> u64 {
    solana_sdk::rent::Rent::default().minimum_balance(0)
}

/// A `[u8; 192]` compressed-proof fixture (workstream G wire format: `A(32)
/// ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ pok(32)`) that mock_verifier ACCEPTS:
/// `A` is a genuine nonzero BN254 G1 point (the curve generator (1,2),
/// compressed host-side with `solana_bn254`'s real -- not mocked --
/// compression), everything else is the all-zero point-at-infinity encoding
/// (always decompresses successfully, see `solana_bn254::compression`'s
/// zero special-case). See `mock_verifier`'s doc comment for why "accept"
/// now needs a real curve point rather than an arbitrary marker byte.
pub fn accepting_proof() -> [u8; 192] {
    use solana_bn254::compression::prelude::alt_bn128_g1_compress;
    // Uncompressed BE G1 generator (x=1, y=2): 32-byte BE x ‖ 32-byte BE y.
    let mut generator_be = [0u8; 64];
    generator_be[31] = 1;
    generator_be[63] = 2;
    let a_compressed = alt_bn128_g1_compress(&generator_be).expect("compress BN254 G1 generator");
    let mut proof = [0u8; 192];
    proof[0..32].copy_from_slice(&a_compressed);
    proof
}

/// All-zero compressed proof: every element decompresses to the identity
/// (point at infinity), so `mock_verifier` rejects it (its `A` element is
/// zero, not a genuine curve point).
pub fn rejecting_proof() -> [u8; 192] {
    [0u8; 192]
}

/// Compresses a real, uncompressed 388-byte Groth16 proof (the
/// `A(64)‖B(128)‖C(64)‖commitment_count:u32be‖commitment(64)‖pok(64)` layout
/// Sunspot's circuits emit -- see `circuits/README.md`) into the 192-byte
/// wire format, using `solana_bn254`'s REAL (not mocked) BN254 compression.
/// Used by the real-verifier KAT test, which must feed the pool a genuinely
/// compressed proof for `verify::decompress_proof` to round-trip on-chain.
pub fn compress_proof_388(uncompressed: &[u8]) -> [u8; 192] {
    use solana_bn254::compression::prelude::{alt_bn128_g1_compress, alt_bn128_g2_compress};
    assert_eq!(uncompressed.len(), 388, "expected the uncompressed 388-byte proof layout");
    let a = &uncompressed[0..64];
    let b = &uncompressed[64..192];
    let c = &uncompressed[192..256];
    // uncompressed[256..260] is the big-endian commitment_count (always 1).
    let commitment = &uncompressed[260..324];
    let pok = &uncompressed[324..388];

    let mut out = [0u8; 192];
    out[0..32].copy_from_slice(&alt_bn128_g1_compress(a).expect("compress A"));
    out[32..96].copy_from_slice(&alt_bn128_g2_compress(b).expect("compress B"));
    out[96..128].copy_from_slice(&alt_bn128_g1_compress(c).expect("compress C"));
    out[128..160].copy_from_slice(&alt_bn128_g1_compress(commitment).expect("compress commitment"));
    out[160..192].copy_from_slice(&alt_bn128_g1_compress(pok).expect("compress pok"));
    out
}

pub fn dummy_account_lamports_only() -> Account {
    Account { lamports: 0, data: vec![], owner: solana_system_interface::program::ID, executable: false, rent_epoch: 0 }
}

/// A Solana keypair JSON file is a 64-byte array: [0..32) secret key seed,
/// [32..64) public key. Reads just the public key, with no signing crate
/// needed.
pub fn read_pubkey_from_keypair_file(path: &std::path::Path) -> Pubkey {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let bytes: Vec<u8> = serde_json_like_u8_array(&text);
    assert_eq!(bytes.len(), 64, "keypair file {path:?} must be a 64-byte array");
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&bytes[32..64]);
    Pubkey::new_from_array(pk)
}

/// Tiny `[1, 2, 3]`-style JSON-array-of-u8 parser (avoids a serde_json dep).
fn serde_json_like_u8_array(text: &str) -> Vec<u8> {
    text.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse::<u8>().unwrap())
        .collect()
}

/// Loads a `kakure_pool.so` built with `--features dev-verify` (see
/// `programs/kakure_pool/Cargo.toml`) plus a real Sunspot-built verifier
/// program, for the real-verifier CPI test. `verifier_so` and
/// `verifier_keypair_json` are absolute paths.
pub fn setup_dev_verify(verifier_so: &std::path::Path, verifier_keypair_json: &std::path::Path) -> (LiteSVM, Keypair, Pubkey) {
    // See `setup`'s doc comment: needed for `sol_alt_bn128_compression` to
    // actually decompress instead of silently zeroing its output.
    let mut svm = LiteSVM::new().with_mainnet_features();
    let so_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/deploy-dev-verify");
    svm.add_program_from_file(KAKURE_POOL_ID, so_dir.join("kakure_pool.so"))
        .expect("load dev-verify kakure_pool.so (run `just build-dev-verify` / see final report)");

    let verifier_id = read_pubkey_from_keypair_file(verifier_keypair_json);
    svm.add_program_from_file(verifier_id, verifier_so).expect("load real verifier .so");

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    (svm, payer, verifier_id)
}
