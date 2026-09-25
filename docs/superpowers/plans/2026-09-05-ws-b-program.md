# Workstream B — `kakure_pool` program: bite-sized plan

Toolchain note (checked before writing this plan): Anchor 1.1.2 (installed via
`avm` at `~/.avm/bin/anchor-1.1.2`) fails to *run at all* on this container —
`GLIBC_2.39' not found` (container ships glibc 2.35) — and the only other
Anchor on `PATH`, `~/.cargo/bin/anchor` (0.30.0), predates Agave 3.0 support.
Per the task brief's explicit fallback clause, this workstream ships a native
`solana-program` crate with an equivalent account/instruction/event contract,
documented as a deviation from I-3's "Anchor names, args" framing in the
final report.

Each task: write/extend a failing test first, run it (see it fail for the
right reason), implement, run again (green), commit.

1. [x] Workspace scaffold: root `Cargo.toml` (workspace), `programs/kakure_pool`,
   `programs/mock_verifier`. Resolve a mutually-compatible dependency set for
   `solana-program`, `solana-poseidon`, `spl-token{,-2022}`,
   `spl-associated-token-account`, `litesvm`, `litesvm-token`, `solana-sdk`,
   `light-poseidon`/`ark-*` (needed pinning `solana-program = "3"`,
   `solana-sdk = "3"` — the 4.x lines pull a `solana-clock`/`solana-short-vec`
   that conflicts with litesvm 0.16's pin). Commit scaffold.
1b. [x] `cargo build-sbf` toolchain note: solana-program 3.x/4.x's dependency
   graph has a hard floor (solana-instructions-sysvar -> solana-serialize-utils
   ^3.1.2 -> solana-pubkey 4.x -> solana-address 2.x -> wincode >=0.6, itself
   `edition = "2024"`) that the cargo (1.84.0) bundled in platform-tools
   v1.51's `cargo build-sbf` cannot parse. Switched to solana-program 2.x
   (pre micro-crate-split), which never touches that branch; pinned a much
   shorter edition2024 tail (blake3/zeroize/indexmap and their derive
   companions) via `cargo update -p <pkg> --precise <version>` in
   `programs/kakure_pool`'s own Cargo.lock only (not Cargo.toml, so it
   doesn't leak into `tests-litesvm`'s separate workspace). Verified:
   `cargo build-sbf` produces `target/deploy/kakure_pool.so` and
   `mock_verifier.so`.
2. [x] `state.rs`: `Pool`/`Asset`/`Nullifier` fixed-offset layouts matching
   I-2 field order/seeds exactly. `merkle.rs`: `hash3` via `solana_poseidon`
   syscall + frontier `insert` ported from `MerkleTreeLib.sol`. Unit test:
   insert leaves 1..8 (as `[u8;32]` big-endian field encodings of 1..8),
   assert root after each insert. If `circuits/kat/lean_imt_poseidon_v1.json`
   exists in the worktree, assert against it; otherwise self-generate the
   same vectors with `light-poseidon` (BN254, circom params) in the test and
   note in the report that reconciliation with Workstream A is pending.
3. [x] `instruction.rs`, `error.rs`, `events.rs`, `genesis.rs`: enum/errors/
   events per I-3/I-4, `initialize` inserting the genesis leaf. litesvm test:
   deploy program via `cargo build-sbf` output, send `Initialize`, assert
   `Pool` account exists, `next_leaf_index == 1`, one root recorded.
4. [x] `verify.rs` + `programs/mock_verifier`: builds `proof ‖ public_inputs`
   CPI data; mock verifier accepts iff `proof[0] == 0x01`. litesvm test:
   direct CPI-style invoke of `mock_verifier` with both bytes, assert
   accept/reject.
5. [x] `deposit`: asset registry (create-on-first-deposit, `AssetCollision`
   on mint mismatch for an existing `asset_id`), `transfer_checked` into the
   pool's ATA vault, reject Token-2022 mints. litesvm tests: happy path (SPL
   mint, deposit, leaf inserted, vault balance up, CU logged);
   `AmountMismatch`, `AssetMismatch`, `InvalidPublicInputCount`,
   `ComplianceKeyStale`, `InvalidProof` (mock verifier rejects),
   `AssetCollision` (crafted second mint hitting the same PDA — see report
   for how the test forces this), `UnsupportedMint` (Token-2022 mint), `Paused`.
6. [x] `transfer` / `transfer_multisig`: nullifier PDA `init`-once, root ring
   check, two leaf inserts + two `NoteInserted` events. Tests: happy path
   (both circuit ids), `NullifierSpent` (replay), `StaleRoot` (root not in
   ring), `VerifierUnset`.
7. [x] `split_multisig`, `join_multisig`: same pattern, two output leaves /
   two nullifiers respectively. Happy path + error tests as applicable
   (`NullifierSpent` on either nullifier for join).
8. [x] `withdraw` / `withdraw_multisig`: recipient-field check against the
   destination token account, `intent_hash == 0`, `transfer_checked` out of
   the vault signed by the `Pool` PDA. Tests: happy path, `RecipientMismatch`,
   `IntentHashNotZero`, `AmountMismatch`, `AssetMismatch`, `NullifierSpent`,
   `StaleRoot`.
9. [x] Admin ixs (`set_verifier`, `rotate_compliance_key`, `set_paused`):
   authority-gated, `ComplianceKeyRotated` event, version bump. Tests: happy
   path + non-authority rejection (generic `ProgramError`, not in the I-3
   named list — authority checks are outside the frozen error set).
10. [x] Hand-written IDL-equivalent JSON (`packages/sdk/src/solana/idl/kakure_pool.json`)
    describing accounts/instructions/events/discriminants for the SDK team,
    since there is no real Anchor IDL. Commit early even before all
    handlers above are done, per the task brief.
11. [x] Ran the full litesvm suite (`tests-litesvm/`, its own standalone
    workspace -- see task 1b): 16/16 pass. Found and fixed two real
    program bugs in the process (`AccountBorrowFailed` in deposit/withdraw
    from holding `Pool`'s borrow open across a CPI that also touches
    `pool_ai`) plus several test-only bugs (zero placeholder leaves,
    wrong `MintTo` payer, a replayed-tx signature collision). CU:
    initialize=8985, deposit=37616 (repeat)/51116 (first, same asset+ATA
    creation), transfer=15983, withdraw=19588. See final report for the
    full breakdown and the CPI-error-remapping finding.

## Worktree switch (coordinator direction, `~/kakure-wt/b-integ`)

12. [x] Genesis reconciliation: `initialize` takes `genesis_leaf: [u8;32]`
    (client-computed Poseidon2); deleted the Poseidon-v1 placeholder
    (`genesis.rs`). Updated `instruction.rs`, the IDL JSON, every test.
13. [x] `verify_cpi` now emits the real 12-byte gnark witness header before
    the public-input body (closes the "known gap" from the first report).
    Added `PoolInstruction::VerifyOnly` (dev/test only, gated behind the
    `dev-verify` cargo feature, appended at the end of the enum so no
    other instruction's wire tag shifts) and a litesvm test that loads the
    real `transfer_multisig` verifier program + its KAT `.proof`/`.pw` and
    verifies it through a real CPI: 582,167 CU.
14. [x] Added `deposit_token2022_mint_is_rejected` (raw Token-2022-owned
    Mint fixture via `litesvm::set_account`, no spl-token-2022 dependency).
15. [x] Built `kakure_pool.so`/`mock_verifier.so` (`cargo build-sbf`, this
    worktree's ext4 `target/`) plus a `dev-verify`-featured
    `kakure_pool.so` (separate `--sbf-out-dir target/deploy-dev-verify`,
    used only by the real-verifier test). Copied the non-dev-verify pair
    + keypairs to `programs/deploy/` (tracked; `.gitignore` carve-out) for
    e2e (F) to load without needing the SBF toolchain itself.

All 18 litesvm tests + the KAT unit test pass on this worktree.
