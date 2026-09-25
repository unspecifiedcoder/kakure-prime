mod common;

use common::*;
use kakure_pool::instruction::PoolInstruction;
use kakure_pool::state::Pool;
use litesvm_token::{get_spl_account, spl_token, CreateAssociatedTokenAccount, CreateMint, MintTo};
use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::sysvar;
use solana_system_interface::program as system_program;

// Thin wrappers around kakure_pool's helpers that convert this workspace's
// `Pubkey` (solana-sdk 3.x / `Address`) to kakure_pool's own `Pubkey`
// (solana-program 2.x) at the boundary -- see `common::to_kp`.
fn asset_id_bytes(mint: &Pubkey) -> [u8; 20] {
    kakure_pool::helpers::asset_id_bytes(&to_kp(mint))
}
fn asset_id_field(mint: &Pubkey) -> [u8; 32] {
    kakure_pool::helpers::asset_id_field(&to_kp(mint))
}
fn recipient_field(destination: &Pubkey) -> [u8; 32] {
    kakure_pool::helpers::recipient_field(&to_kp(destination))
}

fn verifiers_all(v: Pubkey) -> [solana_program::pubkey::Pubkey; 7] {
    let v = to_kp(&v);
    [v, v, v, v, v, v, v]
}

fn do_initialize(svm: &mut litesvm::LiteSVM, payer: &Keypair) {
    set_program_data_account(svm, &payer.pubkey());
    let accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new_readonly(program_data_key(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    let cu = send(
        svm,
        payer,
        &[],
        accounts,
        PoolInstruction::Initialize {
            compliance_pk_x: [1u8; 32],
            compliance_pk_y: [2u8; 32],
            verifiers: verifiers_all(MOCK_VERIFIER_ID),
            genesis_leaf: field_of_u64(999_999), // stand-in for a client-computed Poseidon2 leaf
        },
    )
    .expect("initialize should succeed");
    eprintln!("CU initialize = {cu}");
}

#[test]
fn initialize_inserts_genesis_leaf() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    let acc = svm.get_account(&pool_key()).unwrap();
    let mut data = acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert_eq!(pool.next_leaf_index(), 1, "genesis leaf inserted");
    assert_eq!(from_kp(&pool.authority()), payer.pubkey());
    assert!(!pool.paused());
    assert_eq!(pool.compliance_pk_x(), [1u8; 32]);
    assert_eq!(from_kp(&pool.verifier(0).unwrap()), MOCK_VERIFIER_ID);
}

#[test]
fn set_paused_blocks_further_state_changing_ixs() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    let accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], accounts, PoolInstruction::SetPaused { paused: true }).unwrap();

    let acc = svm.get_account(&pool_key()).unwrap();
    let mut data = acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert!(pool.paused());

    // A paused pool must reject transfer (PoolError::Paused = custom(0)).
    let accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(nullifier_key(&[3u8; 32]), false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ];
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer {
            proof: accepting_proof(),
            public_inputs: vec![[0u8; 32]; 21],
            root_index: 0,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

#[test]
fn rotate_compliance_key_bumps_version() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    let accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], accounts, PoolInstruction::RotateComplianceKey { x: [9u8; 32], y: [10u8; 32] })
        .unwrap();

    let acc = svm.get_account(&pool_key()).unwrap();
    let mut data = acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert_eq!(pool.compliance_version(), 1);
    assert_eq!(pool.compliance_pk_x(), [9u8; 32]);
}

#[test]
fn asset_id_field_matches_helper_across_mints() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    assert_ne!(asset_id_bytes(&a), asset_id_bytes(&b));
    let f = asset_id_field(&a);
    assert_eq!(&f[0..12], &[0u8; 12]);
}

#[test]
fn recipient_field_top_byte_is_zeroed() {
    let dest = Pubkey::new_unique();
    let f = recipient_field(&dest);
    assert_eq!(f[0], 0);
}

/// Sets up: initialized pool, a fresh 6-decimal mint, `amount` tokens minted
/// into a fresh depositor ATA. Returns (mint, depositor, depositor_ata).
fn setup_mint_and_depositor(svm: &mut litesvm::LiteSVM, payer: &Keypair, amount: u64) -> (Pubkey, Keypair, Pubkey) {
    let mint_authority = Keypair::new();
    let mint = CreateMint::new(svm, payer).authority(&mint_authority.pubkey()).decimals(6).send().unwrap();

    let depositor = Keypair::new();
    svm.airdrop(&depositor.pubkey(), 10_000_000_000).unwrap();

    let depositor_ata = CreateAssociatedTokenAccount::new(svm, &depositor, &mint).send().unwrap();

    MintTo::new(svm, payer, &mint, &depositor_ata, amount).owner(&mint_authority).send().unwrap();

    (mint, depositor, depositor_ata)
}

fn deposit_accounts(
    depositor: &Pubkey,
    mint: &Pubkey,
    vault: &Pubkey,
    depositor_ata: &Pubkey,
    asset_id: &[u8; 20],
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*depositor, true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(asset_key(asset_id), false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*vault, false),
        AccountMeta::new(*depositor_ata, false),
        AccountMeta::new_readonly(spl_token::ID, false),
        AccountMeta::new_readonly(spl_associated_token_account::ID, false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ]
}

/// Workstream G wire format: 11 public inputs, no `cpk_x`/`cpk_y` (the pool
/// injects its own compliance key before the CPI) -- `[leaf, eph_pub_x,
/// value, asset_id, ct0..6]`.
fn deposit_inputs(mint: &Pubkey, leaf: [u8; 32], amount: u64) -> Vec<[u8; 32]> {
    let mut inputs = vec![leaf, [4u8; 32], field_of_u64(amount), asset_id_field(mint)];
    inputs.extend(std::iter::repeat([0u8; 32]).take(7)); // ct0..6
    inputs
}

#[test]
fn deposit_happy_path_inserts_leaf_and_moves_tokens() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let leaf = field_of_u64(42);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let cu = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint, leaf, 500_000),
            amount: 500_000,
        },
    )
    .expect("deposit should succeed");
    eprintln!("CU deposit = {cu}");

    let vault_state: spl_token::state::Account = get_spl_account(&svm, &vault).unwrap();
    assert_eq!(vault_state.amount, 500_000);

    let pool_acc = svm.get_account(&pool_key()).unwrap();
    let mut data = pool_acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert_eq!(pool.next_leaf_index(), 2); // genesis + this deposit
}

#[test]
fn deposit_amount_mismatch_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
            amount: 400_000, // mismatch vs public input value 500_000
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 7 /* AmountMismatch */);
}

#[test]
fn deposit_invalid_proof_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: rejecting_proof(),
            public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
            amount: 500_000,
        },
    )
    .unwrap_err();
    // NOT Custom(5)/PoolError::InvalidProof here: `rejecting_proof()` is a
    // proof that decompresses fine (all-zero -> point-at-infinity encoding
    // everywhere) but that MOCK_VERIFIER's own CPI logic rejects (its `A`
    // element is zero, not a genuine curve point -- see mock_verifier's doc
    // comment). Once a CPI (the verifier call) fails, Solana's runtime
    // aborts the transaction immediately with the CALLEE's error -- the
    // caller's `.map_err(..)` after `invoke()` never runs (there is no way
    // to "catch" a failed CPI and substitute a different error). See the
    // workstream-B final report: `InvalidProof` in I-3's error list is
    // aspirational for CPI-level rejections for this reason; the error
    // SDK/indexer code will actually observe there is the verifier
    // program's own error (here, mock_verifier's own
    // `ProgramError::InvalidInstructionData`). `InvalidProof` IS surfaced
    // directly for a proof that fails to *decompress* -- see
    // `deposit_undecompressable_proof_is_rejected` below.
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::InvalidInstructionData) => {}
        other => panic!("expected InvalidInstructionData (verifier's own rejection code), got {other:?}"),
    }
}

#[test]
fn deposit_undecompressable_proof_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    // A nonzero-but-garbage compressed `A` element: not the all-zero
    // point-at-infinity special case, and (astronomically likely) not a
    // valid compressed encoding of a real curve point either -- this
    // exercises `verify::decompress_proof`'s own `PoolError::InvalidProof`
    // mapping, entirely at the pool level, before any verifier CPI happens.
    let mut proof = [0u8; 192];
    proof[0] = 0xff;
    proof[1] = 0xff;

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof,
            public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
            amount: 500_000,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 5 /* InvalidProof */);
}

#[test]
fn deposit_wrong_public_input_count_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: vec![[0u8; 32]; 5], // wrong count, should be 11
            amount: 500_000,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 1 /* InvalidPublicInputCount */);
}

// ---------------------------------------------------------------------------
// transfer: deposit first to get a known root index, then spend it.
// ---------------------------------------------------------------------------

/// Deposits once and returns the `root_index` (ring-buffer slot) of the
/// resulting root -- workstream G's spend ixs take this index directly
/// rather than a 32-byte root value.
fn deposit_once(svm: &mut litesvm::LiteSVM, payer: &Keypair) -> u8 {
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(svm, payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let leaf = field_of_u64(77);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, leaf, 500_000), amount: 500_000 },
    )
    .unwrap();

    let pool_acc = svm.get_account(&pool_key()).unwrap();
    let mut data = pool_acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    pool.root_cursor().wrapping_sub(1)
}

/// Workstream G wire format: 21 public inputs, no `cpk_x`/`cpk_y`/`root` --
/// `[nullifier, memo_leaf, memo_eph_x, memo_tag, memo_cek_wrap, memo_ct0..6,
/// change_leaf, change_eph_x, change_ct0..6]`.
fn transfer_inputs(nullifier: [u8; 32]) -> Vec<[u8; 32]> {
    // Leaf fields must be nonzero: `merkle::insert` rejects the zero leaf
    // (spec: "leaf 0 rejected").
    let mut v = vec![nullifier];
    v.extend(std::iter::repeat([0u8; 32]).take(21 - 1));
    v[1] = field_of_u64(101); // memo_leaf
    v[12] = field_of_u64(102); // change_leaf
    v
}

fn transfer_accounts(payer: &Pubkey, nullifier: &[u8; 32]) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(nullifier_key(nullifier), false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ]
}

#[test]
fn transfer_happy_path_inserts_two_leaves_and_spends_nullifier() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);

    let nullifier = [5u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .expect("transfer should succeed");
    eprintln!("CU transfer = {cu}");

    assert!(svm.get_account(&nullifier_key(&nullifier)).is_some());

    let pool_acc = svm.get_account(&pool_key()).unwrap();
    let mut data = pool_acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert_eq!(pool.next_leaf_index(), 4); // genesis + deposit + 2 transfer leaves
}

#[test]
fn transfer_replayed_nullifier_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);

    let nullifier = [6u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    send(
        &mut svm,
        &payer,
        &[],
        accounts.clone(),
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .unwrap();

    // Force a fresh blockhash so the replay is a distinct transaction
    // signature -- otherwise litesvm's duplicate-signature detection
    // ("AlreadyProcessed") short-circuits before the program even runs,
    // which would mask the on-chain `NullifierSpent` check this test means
    // to exercise.
    svm.expire_blockhash();

    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .unwrap_err();
    assert_custom_error(&err, 4 /* NullifierSpent */);
}

#[test]
fn transfer_stale_root_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let _root_index = deposit_once(&mut svm, &payer);

    // `root_index = 250` points at a ring-buffer slot never written by
    // either `initialize` (genesis leaf) or the one deposit above -- reading
    // it returns the all-zero "never written" sentinel, which
    // `resolve_root` rejects with `StaleRoot` rather than treating [0u8;32]
    // as a legitimate root.
    let nullifier = [7u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index: 250 },
    )
    .unwrap_err();
    assert_custom_error(&err, 3 /* StaleRoot */);
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

fn withdraw_accounts(
    payer: &Pubkey,
    nullifier: &[u8; 32],
    asset_id: &[u8; 20],
    mint: &Pubkey,
    vault: &Pubkey,
    destination: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(nullifier_key(nullifier), false),
        AccountMeta::new(asset_key(asset_id), false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*vault, false),
        AccountMeta::new(*destination, false),
        AccountMeta::new_readonly(spl_token::ID, false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ]
}

/// Workstream G wire format: 14 public inputs, no `cpk_x`/`cpk_y`/`root` --
/// `[value, recipient, intent_hash, nullifier, asset_id, change_leaf,
/// change_eph_x, change_ct0..6]`.
fn withdraw_inputs(
    value: u64,
    recipient: [u8; 32],
    intent_hash: [u8; 32],
    nullifier: [u8; 32],
    asset_id_f: [u8; 32],
) -> Vec<[u8; 32]> {
    let mut v = vec![field_of_u64(value), recipient, intent_hash, nullifier, asset_id_f];
    v.extend(std::iter::repeat([0u8; 32]).take(14 - 5)); // change_leaf, change_eph_x, change_ct0..6
    v[5] = field_of_u64(201); // change_leaf must be nonzero (leaf 0 rejected)
    v
}

#[test]
fn withdraw_happy_path_pays_destination() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let leaf = field_of_u64(88);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, leaf, 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        let pool = Pool::new(&mut data).unwrap();
        pool.root_cursor().wrapping_sub(1)
    };

    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [8u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .expect("withdraw should succeed");
    eprintln!("CU withdraw = {cu}");

    let dest_state: spl_token::state::Account = get_spl_account(&svm, &destination).unwrap();
    assert_eq!(dest_state.amount, 200_000);
}

#[test]
fn withdraw_recipient_mismatch_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        let pool = Pool::new(&mut data).unwrap();
        pool.root_cursor().wrapping_sub(1)
    };

    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [9u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, [0xffu8; 32], [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 10 /* RecipientMismatch */);
}

#[test]
fn withdraw_intent_hash_not_zero_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        let pool = Pool::new(&mut data).unwrap();
        pool.root_cursor().wrapping_sub(1)
    };

    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [11u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0x01u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 11 /* IntentHashNotZero */);
}

// ---------------------------------------------------------------------------
// Token-2022 mints are rejected by deposit (spec §4).
// ---------------------------------------------------------------------------

#[test]
fn deposit_token2022_mint_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);

    // A minimal (no extensions) SPL Token Mint, packed the same way for
    // both the classic and Token-2022 programs -- the only thing that
    // actually needs to differ for this check is the *owner* of the
    // account. Inject it directly (no CPI/instruction needed for a test
    // fixture) rather than depending on the spl-token-2022 crate, which
    // would reopen the edition2024 dependency chain documented in
    // programs/kakure_pool/Cargo.toml.
    let mint = Keypair::new();
    let mint_authority = Keypair::new();
    use solana_program_option::COption;
    use solana_program_pack::Pack;
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    {
        let m = spl_token::state::Mint {
            mint_authority: COption::Some(mint_authority.pubkey()),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        Pack::pack(m, &mut data).unwrap();
    }
    let token_2022_owner = from_kp(&kakure_pool::TOKEN_2022_PROGRAM_ID);
    svm.set_account(
        mint.pubkey(),
        solana_account::Account {
            lamports: 1_000_000,
            data,
            owner: token_2022_owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let depositor = Keypair::new();
    svm.airdrop(&depositor.pubkey(), 10_000_000_000).unwrap();
    // The deposit fails on the mint-owner check before ever touching the
    // depositor's token account or the vault, so these can be arbitrary,
    // not-yet-existing addresses.
    let depositor_ata = Pubkey::new_unique();
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint.pubkey());
    let asset_id = asset_id_bytes(&mint.pubkey());

    let accounts = deposit_accounts(&depositor.pubkey(), &mint.pubkey(), &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint.pubkey(), field_of_u64(1), 500_000),
            amount: 500_000,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 12 /* UnsupportedMint */);
}

// ---------------------------------------------------------------------------
// Real Sunspot verifier CPI (dev-verify feature; see common::setup_dev_verify).
// ---------------------------------------------------------------------------

#[test]
fn real_verifier_accepts_transfer_multisig_kat_proof() {
    let circuits_target = std::path::PathBuf::from(
        std::env::var("KAKURE_CIRCUITS_TARGET").unwrap_or_else(|_| {
            format!("{}/kakure/circuits/target", std::env::var("HOME").unwrap_or_else(|_| "/root".to_string()))
        }),
    );
    let verifier_so = circuits_target.join("transfer_multisig.so");
    let verifier_keypair = circuits_target.join("transfer_multisig-keypair.json");
    let proof_path = circuits_target.join("transfer_multisig.proof");
    let pw_path = circuits_target.join("transfer_multisig.pw");

    if !verifier_so.exists() || !proof_path.exists() || !pw_path.exists() {
        eprintln!(
            "SKIP real_verifier_accepts_transfer_multisig_kat_proof: {circuits_target:?} artifacts not found \
             (run workstream A's `just build-circuits` && `just verify-kat` first)"
        );
        return;
    }

    let (mut svm, payer, verifier_id) = setup_dev_verify(&verifier_so, &verifier_keypair);

    // initialize with pool.verifiers[3] (transfer_multisig, I-1 CircuitId 3)
    // set to the real verifier program.
    let mut verifiers = verifiers_all(MOCK_VERIFIER_ID);
    verifiers[3] = to_kp(&verifier_id);
    set_program_data_account(&mut svm, &payer.pubkey());
    let init_accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new_readonly(program_data_key(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    send(
        &mut svm,
        &payer,
        &[],
        init_accounts,
        PoolInstruction::Initialize {
            compliance_pk_x: [1u8; 32],
            compliance_pk_y: [2u8; 32],
            verifiers,
            genesis_leaf: field_of_u64(999_999),
        },
    )
    .expect("initialize should succeed");

    let proof_uncompressed = std::fs::read(&proof_path).unwrap();
    assert_eq!(proof_uncompressed.len(), 388, "unexpected .proof length (expected uncompressed 388-byte layout)");
    // Workstream G wire format: the pool decompresses a 192-byte compressed
    // proof on-chain (`verify::decompress_proof`) before this CPI. Compress
    // the real KAT fixture host-side (real, not mocked, BN254 compression)
    // to exercise that round-trip end to end.
    let proof = compress_proof_388(&proof_uncompressed);

    let pw = std::fs::read(&pw_path).unwrap();
    assert_eq!(pw.len(), 12 + 24 * 32, "unexpected .pw length for transfer_multisig (24 public inputs)");
    let public_inputs: Vec<[u8; 32]> = (0..24)
        .map(|i| {
            let start = 12 + i * 32;
            let mut f = [0u8; 32];
            f.copy_from_slice(&pw[start..start + 32]);
            f
        })
        .collect();

    let accounts = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(pool_key(), false),
        AccountMeta::new_readonly(verifier_id, false),
    ];
    let cu = send(&mut svm, &payer, &[], accounts, PoolInstruction::VerifyOnly { circuit_id: 3, proof, public_inputs })
        .expect("real verifier should accept the transfer_multisig KAT proof");
    eprintln!("CU real transfer_multisig verify (with on-chain decompression) = {cu}");
}

/// slice-2 F-1 regression, real verifier (not mock_verifier, not the pool's own
/// `recipient == recipient_field(destination)` re-derivation which `withdraw_recipient_mismatch_is_rejected`
/// already covers): a real Groth16 proof for `withdraw`'s public-input-binding KAT, with
/// `public_inputs[1]` (`recipient`) bit-flipped, must be REJECTED by the real Sunspot-built
/// verifier CPI. Before the F-1 fix (`_recipient`/`_intent_hash` unreferenced in
/// `circuits/standard/withdraw/src/main.nr`), Groth16 left `vk.K[1]` = the point at infinity, so
/// the proof verified for ANY `recipient` value -- an attacker could relay someone else's withdraw
/// tx with both `public_inputs[1]` and `destination_token_account` swapped to their own account,
/// consistently, and the pool's own equality check would never see a mismatch. This proves the
/// real verifier -- not just `sunspot verify` from the CLI (`circuits/manifest.test.ts`'s VK guard
/// covers that) -- now rejects the mutated proof through the exact CPI path `withdraw` uses.
#[test]
fn real_verifier_rejects_withdraw_kat_with_mutated_recipient_input() {
    let circuits_target = std::path::PathBuf::from(
        std::env::var("KAKURE_CIRCUITS_TARGET").unwrap_or_else(|_| {
            format!("{}/kakure/circuits/target", std::env::var("HOME").unwrap_or_else(|_| "/root".to_string()))
        }),
    );
    let verifier_so = circuits_target.join("withdraw.so");
    let verifier_keypair = circuits_target.join("withdraw-keypair.json");
    let proof_path = circuits_target.join("withdraw.proof");
    let pw_path = circuits_target.join("withdraw.pw");

    if !verifier_so.exists() || !proof_path.exists() || !pw_path.exists() {
        eprintln!(
            "SKIP real_verifier_rejects_withdraw_kat_with_mutated_recipient_input: {circuits_target:?} artifacts \
             not found (run workstream A's `just build-circuits` for `withdraw`, then regenerate its KAT proof)"
        );
        return;
    }

    let (mut svm, payer, verifier_id) = setup_dev_verify(&verifier_so, &verifier_keypair);

    let mut verifiers = verifiers_all(MOCK_VERIFIER_ID);
    verifiers[2] = to_kp(&verifier_id); // withdraw is I-1 CircuitId 2
    set_program_data_account(&mut svm, &payer.pubkey());
    let init_accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new_readonly(program_data_key(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    send(
        &mut svm,
        &payer,
        &[],
        init_accounts,
        PoolInstruction::Initialize {
            compliance_pk_x: [1u8; 32],
            compliance_pk_y: [2u8; 32],
            verifiers,
            genesis_leaf: field_of_u64(999_999),
        },
    )
    .expect("initialize should succeed");

    let proof_uncompressed = std::fs::read(&proof_path).unwrap();
    assert_eq!(proof_uncompressed.len(), 388, "unexpected .proof length (expected uncompressed 388-byte layout)");
    let proof = compress_proof_388(&proof_uncompressed);

    let pw = std::fs::read(&pw_path).unwrap();
    assert_eq!(pw.len(), 12 + 17 * 32, "unexpected .pw length for withdraw (17 public inputs)");
    let read_input = |pw: &[u8], i: usize| -> [u8; 32] {
        let start = 12 + i * 32;
        let mut f = [0u8; 32];
        f.copy_from_slice(&pw[start..start + 32]);
        f
    };
    let public_inputs: Vec<[u8; 32]> = (0..17).map(|i| read_input(&pw, i)).collect();

    let accounts = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(pool_key(), false),
        AccountMeta::new_readonly(verifier_id, false),
    ];

    // Baseline: the unmutated KAT proof against its own public witness verifies.
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts.clone(),
        PoolInstruction::VerifyOnly { circuit_id: 2, proof, public_inputs: public_inputs.clone() },
    )
    .expect("real verifier should accept the unmutated withdraw KAT proof");
    eprintln!("CU real withdraw verify (baseline) = {cu}");

    // public_inputs[1] is `recipient` (I-1 flat order: withdraw_value, recipient, intent_hash, ...).
    // Flip its low bit -- everything else (proof, other inputs) stays byte-identical.
    let mut mutated = public_inputs.clone();
    mutated[1][31] ^= 0x01;
    let err = send(&mut svm, &payer, &[], accounts, PoolInstruction::VerifyOnly { circuit_id: 2, proof, public_inputs: mutated })
        .expect_err("real verifier must reject a withdraw proof whose recipient public input was mutated");
    eprintln!("withdraw + mutated recipient correctly rejected: {err:?}");
}

// ---------------------------------------------------------------------------
// F2: token_program / ata_program pinning (deposit) and the mirrored
// token_program pin on withdraw_like; the asset-vault check for a second
// deposit.
// ---------------------------------------------------------------------------

#[test]
fn deposit_wrong_token_program_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    // Any executable that is not spl_token stands in for an attacker "token program".
    let evil_token_program = MOCK_VERIFIER_ID;
    let vault = from_kp(&kakure_pool::ata::get_associated_token_address(
        &to_kp(&pool_key()),
        &to_kp(&mint),
        &to_kp(&evil_token_program),
    ));
    let asset_id = asset_id_bytes(&mint);
    let mut accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    accounts[6] = AccountMeta::new_readonly(evil_token_program, false);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
            amount: 500_000,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 12 /* UnsupportedMint */);
}

#[test]
fn withdraw_wrong_token_program_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };
    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [50u8; 32];
    let mut accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    accounts[7] = AccountMeta::new_readonly(MOCK_VERIFIER_ID, false); // not spl_token::ID
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::IncorrectProgramId)), "{err:?}");
}

#[test]
fn deposit_asset_collision_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    // Forge an Asset account at THIS mint's asset_id PDA registered to a
    // DIFFERENT mint -- an asset_id collision is astronomically unlikely in
    // practice (asset_id = sha256(mint)[0..20]), but this exercises the
    // on-chain `asset.mint() != mint_ai.key` guard directly.
    let other_mint = Pubkey::new_unique();
    let mut adata = vec![0u8; kakure_pool::state::ASSET_LEN];
    {
        let mut asset = kakure_pool::state::Asset::new(&mut adata).unwrap();
        asset.write(&to_kp(&other_mint), &to_kp(&vault), &asset_id, 0);
    }
    svm.set_account(
        asset_key(&asset_id),
        solana_account::Account { lamports: 1_000_000, data: adata, owner: KAKURE_POOL_ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
            amount: 500_000,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 9 /* AssetCollision */);
}

#[test]
fn second_deposit_to_existing_asset_succeeds() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 2_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(11), 500_000), amount: 500_000 },
    )
    .unwrap();

    svm.expire_blockhash();
    let accounts2 = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts2,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(12), 500_000), amount: 500_000 },
    )
    .expect("second deposit to an existing asset should succeed");

    let vault_state: spl_token::state::Account = get_spl_account(&svm, &vault).unwrap();
    assert_eq!(vault_state.amount, 1_000_000);
}

#[test]
fn second_deposit_with_different_vault_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 2_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);

    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(13), 500_000), amount: 500_000 },
    )
    .unwrap();

    // Second deposit of the SAME mint but with a DIFFERENT (attacker-chosen) "vault" address --
    // the real ATA for this mint/pool/token-program is already registered on `asset`, so this
    // must be rejected regardless of what `expected_vault` recomputes to.
    svm.expire_blockhash();
    let other_vault = Pubkey::new_unique();
    let accounts2 = deposit_accounts(&depositor.pubkey(), &mint, &other_vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts2,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(14), 500_000), amount: 500_000 },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidSeeds)), "{err:?}");
}

#[test]
fn deposit_zero_leaf_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, [0u8; 32], 500_000), amount: 500_000 },
    )
    .unwrap_err();
    assert_custom_error(&err, 6 /* InvalidLeaf */);
}

#[test]
fn deposit_paused_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let admin_accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], admin_accounts, PoolInstruction::SetPaused { paused: true }).unwrap();

    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let err = send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

#[test]
fn withdraw_amount_mismatch_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };
    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [51u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 150_000, // mismatch vs public input value 200_000
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 7 /* AmountMismatch */);
}

#[test]
fn withdraw_asset_mismatch_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };
    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [52u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(
                200_000,
                recipient_field(&destination),
                [0u8; 32],
                nullifier,
                asset_id_field(&Pubkey::new_unique()), // wrong asset_id public input
            ),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 8 /* AssetMismatch */);
}

#[test]
fn withdraw_paused_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(91), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };
    let admin_accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], admin_accounts, PoolInstruction::SetPaused { paused: true }).unwrap();
    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [53u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Withdraw {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

// ---------------------------------------------------------------------------
// F3: PDA "init" tolerates lamports pre-funded before creation (griefing
// resistance).
// ---------------------------------------------------------------------------

#[test]
fn transfer_succeeds_when_nullifier_pda_is_prefunded() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [13u8; 32];
    svm.airdrop(&nullifier_key(&nullifier), griefing_lamports()).unwrap(); // griefing lamport (see griefing_lamports() doc comment)
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .expect("a pre-funded nullifier address must not count as spent");
    let acc = svm.get_account(&nullifier_key(&nullifier)).unwrap();
    assert_eq!(acc.owner, KAKURE_POOL_ID);
    assert_eq!(acc.data.len(), 1);
}

#[test]
fn deposit_succeeds_when_asset_pda_is_prefunded() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    svm.airdrop(&asset_key(&asset_id), griefing_lamports()).unwrap();
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(42), 500_000), amount: 500_000 },
    )
    .expect("a pre-funded asset PDA must not block the first deposit");
}

#[test]
fn initialize_succeeds_when_pool_pda_is_prefunded() {
    let (mut svm, payer) = setup();
    svm.airdrop(&pool_key(), griefing_lamports()).unwrap();
    do_initialize(&mut svm, &payer);
    let acc = svm.get_account(&pool_key()).unwrap();
    assert_eq!(acc.owner, KAKURE_POOL_ID);
}

// ---------------------------------------------------------------------------
// F4: pool account address must be a real, program-owned pool PDA on every
// admin/spend ix, not merely whatever the caller placed at that slot.
// ---------------------------------------------------------------------------

#[test]
fn transfer_rejects_non_pda_pool_account() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    // Forge a program-owned "pool" with an accepting verifier and one nonzero root slot.
    let real = svm.get_account(&pool_key()).unwrap();
    let fake_key = Pubkey::new_unique();
    svm.set_account(fake_key, real.clone()).unwrap();
    let nullifier = [21u8; 32];
    let mut accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    accounts[1] = AccountMeta::new(fake_key, false);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index: 0 },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidSeeds)), "{err:?}");
    assert!(svm.get_account(&nullifier_key(&nullifier)).is_none(), "no nullifier may be burned against a fake pool");
}

#[test]
fn set_paused_rejects_non_pda_pool_account() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let real = svm.get_account(&pool_key()).unwrap();
    let fake_key = Pubkey::new_unique();
    svm.set_account(fake_key, real.clone()).unwrap();
    let accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(fake_key, false)];
    let err = send(&mut svm, &payer, &[], accounts, PoolInstruction::SetPaused { paused: true }).unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidSeeds)), "{err:?}");
}

// ---------------------------------------------------------------------------
// F5: admin-signer authorization, verifier-registry edge cases, ring-buffer
// wrap, split/join/withdraw_multisig/transfer_multisig through the pool
// handler, and the intermediate-root-is-still-spendable case.
// ---------------------------------------------------------------------------

#[test]
fn admin_ixs_reject_non_authority_signer() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let accounts = vec![AccountMeta::new(mallory.pubkey(), true), AccountMeta::new(pool_key(), false)];
    for ix in [
        PoolInstruction::SetPaused { paused: true },
        PoolInstruction::RotateComplianceKey { x: [7u8; 32], y: [8u8; 32] },
        PoolInstruction::SetVerifier { circuit_id: 0, program: to_kp(&mallory.pubkey()) },
    ] {
        let err = send(&mut svm, &mallory, &[], accounts.clone(), ix).unwrap_err();
        use solana_instruction_error::InstructionError;
        use solana_transaction_error::TransactionError;
        assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidAccountData)), "{err:?}");
    }
}

#[test]
fn ring_buffer_wraps_at_256_and_reuses_slot_zero() {
    let (mut svm, payer) = setup(); // slot 0 = genesis root
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer); // slot 1
    // 128 transfers = 256 inserts -> cursor wraps; slot 0 must now hold a *new* root.
    let genesis_root = {
        let a = svm.get_account(&pool_key()).unwrap();
        let mut d = a.data.clone();
        Pool::new(&mut d).unwrap().root_at(0)
    };
    for i in 0..128u8 {
        let mut nullifier = [0u8; 32];
        nullifier[0] = 0xA0;
        nullifier[1] = i;
        svm.expire_blockhash();
        send(
            &mut svm,
            &payer,
            &[],
            transfer_accounts(&payer.pubkey(), &nullifier),
            PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
        )
        .unwrap();
    }
    let a = svm.get_account(&pool_key()).unwrap();
    let mut d = a.data.clone();
    let pool = Pool::new(&mut d).unwrap();
    assert_eq!(pool.root_cursor(), 2u8.wrapping_add(0)); // 2 + 256 mod 256
    assert_ne!(pool.root_at(0), genesis_root);
    assert_eq!(pool.next_leaf_index(), 2 + 256);
    // genesis slot was overwritten: proving against slot 0 now targets the new root, which the
    // mock verifier cannot distinguish; the real-verifier e2e covers rejection.
}

#[test]
fn transfer_can_spend_against_intermediate_root_between_two_inserts_of_one_transfer() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier1 = [72u8; 32];
    send(
        &mut svm,
        &payer,
        &[],
        transfer_accounts(&payer.pubkey(), &nullifier1),
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier1), root_index },
    )
    .unwrap();
    // Root ring after this transfer: genesis(0), deposit(1), memo-insert(2), change-insert(3) ->
    // cursor=4. Slot 2 holds the INTERMEDIATE root (right after the memo insert, before the
    // change insert) -- a legitimate, spendable root even though it was never the tree's "final"
    // state after any one instruction.
    let intermediate_root_index = 2u8;
    svm.expire_blockhash();
    let nullifier2 = [73u8; 32];
    send(
        &mut svm,
        &payer,
        &[],
        transfer_accounts(&payer.pubkey(), &nullifier2),
        PoolInstruction::Transfer {
            proof: accepting_proof(),
            public_inputs: transfer_inputs(nullifier2),
            root_index: intermediate_root_index,
        },
    )
    .expect("an intermediate root between two inserts of one transfer must remain spendable");
}

#[test]
fn transfer_verifier_unset_is_rejected() {
    let (mut svm, payer) = setup();
    set_program_data_account(&mut svm, &payer.pubkey());
    let accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new_readonly(program_data_key(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    let mut verifiers = verifiers_all(MOCK_VERIFIER_ID);
    verifiers[1] = solana_program::pubkey::Pubkey::default(); // circuit 1 = transfer, left unset
    send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Initialize {
            compliance_pk_x: [1u8; 32],
            compliance_pk_y: [2u8; 32],
            verifiers,
            genesis_leaf: field_of_u64(999_999),
        },
    )
    .unwrap();

    let nullifier = [74u8; 32];
    let mut accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    // Must match the pool's (unset) stored verifier for `verify_cpi`'s program-id check to even
    // reach the `VerifierUnset` branch instead of failing earlier with `IncorrectProgramId`.
    accounts[4] = AccountMeta::new_readonly(from_kp(&solana_program::pubkey::Pubkey::default()), false);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index: 0 },
    )
    .unwrap_err();
    assert_custom_error(&err, 13 /* VerifierUnset */);
}

#[test]
fn transfer_wrong_verifier_account_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [75u8; 32];
    let mut accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    accounts[4] = AccountMeta::new_readonly(Pubkey::new_unique(), false); // not pool.verifiers[1]
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::IncorrectProgramId)), "{err:?}");
}

fn split_inputs(nullifier: [u8; 32]) -> Vec<[u8; 32]> {
    let mut v = vec![nullifier];
    v.extend(std::iter::repeat([0u8; 32]).take(19 - 1));
    v[1] = field_of_u64(301); // out1_leaf
    v[10] = field_of_u64(302); // out2_leaf
    v
}

fn join_accounts(payer: &Pubkey, nullifier_a: &[u8; 32], nullifier_b: &[u8; 32]) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(nullifier_key(nullifier_a), false),
        AccountMeta::new(nullifier_key(nullifier_b), false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ]
}

fn join_inputs(nullifier_a: [u8; 32], nullifier_b: [u8; 32]) -> Vec<[u8; 32]> {
    let mut v = vec![nullifier_a, nullifier_b];
    v.extend(std::iter::repeat([0u8; 32]).take(11 - 2));
    v[2] = field_of_u64(401); // out_leaf
    v
}

#[test]
fn transfer_multisig_happy_path_inserts_two_leaves_and_spends_nullifier() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [61u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::TransferMultisig { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .expect("transfer_multisig should succeed");
    eprintln!("CU transfer_multisig = {cu}");
    assert!(cu < 1_400_000);
    assert!(svm.get_account(&nullifier_key(&nullifier)).is_some());
}

#[test]
fn split_multisig_happy_path_inserts_two_leaves_and_spends_nullifier() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [62u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier); // same account shape as transfer
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::SplitMultisig { proof: accepting_proof(), public_inputs: split_inputs(nullifier), root_index },
    )
    .expect("split_multisig should succeed");
    eprintln!("CU split_multisig = {cu}");
    assert!(cu < 1_400_000);
    assert!(svm.get_account(&nullifier_key(&nullifier)).is_some());
    let pool_acc = svm.get_account(&pool_key()).unwrap();
    let mut data = pool_acc.data.clone();
    let pool = Pool::new(&mut data).unwrap();
    assert_eq!(pool.next_leaf_index(), 4); // genesis + deposit + 2 split outputs
}

#[test]
fn split_multisig_paused_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let admin_accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], admin_accounts, PoolInstruction::SetPaused { paused: true }).unwrap();
    let nullifier = [63u8; 32];
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::SplitMultisig { proof: accepting_proof(), public_inputs: split_inputs(nullifier), root_index },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

#[test]
fn join_multisig_happy_path_inserts_leaf_and_spends_two_nullifiers() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier_a = [64u8; 32];
    let nullifier_b = [65u8; 32];
    let accounts = join_accounts(&payer.pubkey(), &nullifier_a, &nullifier_b);
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::JoinMultisig {
            proof: accepting_proof(),
            public_inputs: join_inputs(nullifier_a, nullifier_b),
            root_index,
        },
    )
    .expect("join_multisig should succeed");
    eprintln!("CU join_multisig = {cu}");
    assert!(cu < 1_400_000);
    assert!(svm.get_account(&nullifier_key(&nullifier_a)).is_some());
    assert!(svm.get_account(&nullifier_key(&nullifier_b)).is_some());
}

#[test]
fn join_multisig_paused_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let admin_accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], admin_accounts, PoolInstruction::SetPaused { paused: true }).unwrap();
    let nullifier_a = [66u8; 32];
    let nullifier_b = [67u8; 32];
    let accounts = join_accounts(&payer.pubkey(), &nullifier_a, &nullifier_b);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::JoinMultisig {
            proof: accepting_proof(),
            public_inputs: join_inputs(nullifier_a, nullifier_b),
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

#[test]
fn join_multisig_same_nullifier_twice_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [68u8; 32];
    // Pass the SAME PDA as both nullifier accounts.
    let accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new(nullifier_key(&nullifier), false),
        AccountMeta::new(nullifier_key(&nullifier), false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ];
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::JoinMultisig {
            proof: accepting_proof(),
            public_inputs: join_inputs(nullifier, nullifier),
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 4 /* NullifierSpent */);
}

#[test]
fn withdraw_multisig_happy_path_pays_destination() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(89), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };

    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [69u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let cu = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::WithdrawMultisig {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .expect("withdraw_multisig should succeed");
    eprintln!("CU withdraw_multisig = {cu}");
    assert!(cu < 1_400_000);

    let dest_state: spl_token::state::Account = get_spl_account(&svm, &destination).unwrap();
    assert_eq!(dest_state.amount, 200_000);
}

#[test]
fn withdraw_multisig_paused_is_rejected() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit { proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(90), 500_000), amount: 500_000 },
    )
    .unwrap();
    let root_index = {
        let pool_acc = svm.get_account(&pool_key()).unwrap();
        let mut data = pool_acc.data.clone();
        Pool::new(&mut data).unwrap().root_cursor().wrapping_sub(1)
    };
    let admin_accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(pool_key(), false)];
    send(&mut svm, &payer, &[], admin_accounts, PoolInstruction::SetPaused { paused: true }).unwrap();

    let destination = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&payer.pubkey()).send().unwrap();
    let nullifier = [70u8; 32];
    let accounts = withdraw_accounts(&payer.pubkey(), &nullifier, &asset_id, &mint, &vault, &destination);
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::WithdrawMultisig {
            proof: accepting_proof(),
            public_inputs: withdraw_inputs(200_000, recipient_field(&destination), [0u8; 32], nullifier, asset_id_field(&mint)),
            amount: 200_000,
            root_index,
        },
    )
    .unwrap_err();
    assert_custom_error(&err, 0 /* Paused */);
}

// ---------------------------------------------------------------------------
// F8: `VerifyOnly` must be unreachable in a release (non-`dev-verify`) build.
// ---------------------------------------------------------------------------

#[test]
fn verify_only_is_unreachable_in_release_build() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let accounts = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(pool_key(), false),
        AccountMeta::new_readonly(MOCK_VERIFIER_ID, false),
    ];
    let err = send(
        &mut svm,
        &payer,
        &[],
        accounts,
        PoolInstruction::VerifyOnly { circuit_id: 0, proof: accepting_proof(), public_inputs: vec![[0u8; 32]; 13] },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidInstructionData)), "{err:?}");
}

// ---------------------------------------------------------------------------
// F9: `initialize` requires `authority` to equal the deployed program's real
// upgrade authority.
// ---------------------------------------------------------------------------

#[test]
fn initialize_by_non_upgrade_authority_is_rejected() {
    let (mut svm, payer) = setup();
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    // ProgramData records `payer` as the upgrade authority, but `mallory` signs Initialize.
    set_program_data_account(&mut svm, &payer.pubkey());
    let accounts = vec![
        AccountMeta::new(mallory.pubkey(), true),
        AccountMeta::new(pool_key(), false),
        AccountMeta::new_readonly(program_data_key(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    let err = send(
        &mut svm,
        &mallory,
        &[],
        accounts,
        PoolInstruction::Initialize {
            compliance_pk_x: [1u8; 32],
            compliance_pk_y: [2u8; 32],
            verifiers: verifiers_all(MOCK_VERIFIER_ID),
            genesis_leaf: field_of_u64(999_999),
        },
    )
    .unwrap_err();
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidAccountData)), "{err:?}");
}

// ---------------------------------------------------------------------------
// helper: decode a litesvm FailedTransactionMetadata into our custom error code
// ---------------------------------------------------------------------------

fn assert_custom_error(err: &litesvm::types::FailedTransactionMetadata, expected: u32) {
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
            assert_eq!(*code, expected, "unexpected custom error code (got {code}, want {expected}); full: {err:?}");
        }
        other => panic!("expected Custom({expected}), got {other:?}; full: {err:?}"),
    }
}

// keep sysvar import from being flagged unused if a future test needs it
#[allow(dead_code)]
fn _unused() {
    let _ = sysvar::rent::ID;
}

#[test]
fn deposit_note_inserted_log_lands_before_the_verifier_cpi() {
    // F-4 fix (workstream L, root cause of the step-4 note-discovery regression): `NoteInserted`
    // must be logged BEFORE the verifier CPI, not after every other CPI in `deposit` -- a real
    // (non-mock) verifier's own `Program log:` output can be large enough to approach Solana's
    // per-transaction log budget, silently truncating anything logged after it, which is exactly
    // what made the indexer see zero notes for a real deposit even though the transaction itself
    // succeeded. This pins the fix directly against a real litesvm deposit's captured logs (not a
    // hand-built fixture) so a future reordering regresses this test, not just a slow e2e run.
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    let meta = send_full(
        &mut svm,
        &depositor,
        &[],
        accounts,
        PoolInstruction::Deposit {
            proof: accepting_proof(),
            public_inputs: deposit_inputs(&mint, field_of_u64(555), 500_000),
            amount: 500_000,
        },
    )
    .unwrap();

    let note_inserted_idx = meta
        .logs
        .iter()
        .position(|l| l.starts_with("Program data: a2FrdXJlOk5vdGVJbnNlcnRlZA=="))
        .expect("NoteInserted (\"kakure:NoteInserted\" base64-tagged) log line must be present and not truncated");
    let verifier_invoke_idx = meta
        .logs
        .iter()
        .position(|l| l.contains(&format!("Program {MOCK_VERIFIER_ID} invoke")))
        .expect("verifier CPI invoke line must be present");
    assert!(
        note_inserted_idx < verifier_invoke_idx,
        "NoteInserted (index {note_inserted_idx}) must be logged BEFORE the verifier CPI (index {verifier_invoke_idx}); full logs: {:#?}",
        meta.logs,
    );
}

#[test]
fn transfer_nullifier_spent_and_note_inserted_logs_land_before_the_verifier_cpi() {
    // Same fix as `deposit_note_inserted_log_lands_before_the_verifier_cpi`, for a spend ix:
    // `NullifierSpent` and both `NoteInserted` lines must land before the verifier CPI too.
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [77u8; 32];
    let meta = send_full(
        &mut svm,
        &payer,
        &[],
        transfer_accounts(&payer.pubkey(), &nullifier),
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index },
    )
    .unwrap();

    let verifier_invoke_idx = meta
        .logs
        .iter()
        .position(|l| l.contains(&format!("Program {MOCK_VERIFIER_ID} invoke")))
        .expect("verifier CPI invoke line must be present");
    let nullifier_spent_idx = meta
        .logs
        .iter()
        .position(|l| l.starts_with("Program data: a2FrdXJlOk51bGxpZmllclNwZW50"))
        .expect("NullifierSpent log line must be present and not truncated");
    let note_inserted_indices: Vec<usize> = meta
        .logs
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with("Program data: a2FrdXJlOk5vdGVJbnNlcnRlZA=="))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(note_inserted_indices.len(), 2, "expected memo + change NoteInserted lines; full logs: {:#?}", meta.logs);
    assert!(
        nullifier_spent_idx < verifier_invoke_idx,
        "NullifierSpent (index {nullifier_spent_idx}) must be logged BEFORE the verifier CPI (index {verifier_invoke_idx}); full logs: {:#?}",
        meta.logs,
    );
    for idx in note_inserted_indices {
        assert!(
            idx < verifier_invoke_idx,
            "NoteInserted (index {idx}) must be logged BEFORE the verifier CPI (index {verifier_invoke_idx}); full logs: {:#?}",
            meta.logs,
        );
    }
}
