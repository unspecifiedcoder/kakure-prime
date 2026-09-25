//! Instruction encoding for `kakure_pool`.
//!
//! Deviation from I-3 ("Anchor names, args"): Anchor could not run on this
//! toolchain (see crate-level docs / final report), so this is a native
//! `solana-program` crate. Wire format: `borsh::to_vec` of this enum — i.e.
//! a single leading `u8` variant tag (0-indexed in declaration order below,
//! which matches I-3's ordering) followed by the borsh encoding of the
//! variant's fields. This is *not* Anchor's 8-byte sighash discriminator;
//! SDK/indexer/e2e teams must encode/decode with this enum's layout (or the
//! equivalent hand-written borsh schema) rather than `@coral-xyz/anchor`.
//!
//! ## Workstream G: compressed proof + root-index wire format
//!
//! Every proof-carrying instruction previously carried `proof: Vec<u8>`
//! (the uncompressed 388-byte Sunspot/gnark layout) and a full
//! `public_inputs: Vec<[u8; 32]>` including `cpk_x`, `cpk_y` and (for spend
//! ixs) `root` -- together these blew past Solana's 1232-byte packet limit
//! for `transfer`/`transfer_multisig` (24 inputs) and `split_multisig` (22
//! inputs). Fix (see docs/superpowers/plans/2026-09-05-ws-g-txsize.md):
//!
//! - `proof` is now `[u8; 192]`: the compressed Groth16 proof
//!   `A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ commitment_pok(32)`. The pool
//!   decompresses this on-chain (`verify::decompress_proof`, using
//!   `solana_bn254::compression::prelude::{alt_bn128_g1_decompress,
//!   alt_bn128_g2_decompress}`) back into the 388-byte uncompressed layout
//!   the verifier CPI wire format needs, mapping any decompression failure
//!   to `PoolError::InvalidProof`.
//! - Spend ixs (everything except `Deposit`) take `root_index: u8` instead
//!   of a 32-byte root; the pool reads `pool.roots[root_index]`, rejects a
//!   zero (never-written) slot with `PoolError::StaleRoot`, and uses that
//!   value as the root public input.
//! - `public_inputs: Vec<[u8; 32]>` EXCLUDES `cpk_x`, `cpk_y` (all ixs) and
//!   `root` (spend ixs): the pool injects `pool.compliance_pk_x/y` and the
//!   resolved root at the exact positions the circuit's original I-1
//!   input ordering expects before CPI-ing into the verifier (see
//!   `processor.rs`'s `inject_full`). New counts: `Deposit` 11,
//!   `Transfer`/`TransferMultisig` 21, `Withdraw`/`WithdrawMultisig` 14,
//!   `SplitMultisig` 19, `JoinMultisig` 11 (one root, at the original I-1
//!   index 4).
//!
//! Because the pool now injects its own `compliance_pk_x/y` into EVERY
//! verified proof -- `Deposit` included (`processor.rs::deposit` injects
//! `pool.compliance_pk_x()/y()` exactly like every spend ix) -- a
//! caller-supplied-key-vs-pool's-key `ComplianceKeyStale` check is not
//! meaningful for ANY proof-carrying ix, not just spends: the proof can
//! only ever verify against the key the pool itself just injected, so the
//! binding is implicit in the verifier CPI everywhere, `Deposit` included.
//! The `PoolError::ComplianceKeyStale` variant is kept (not renumbered)
//! even though nothing constructs it anymore for any instruction; a proof
//! made under an old key instead fails INSIDE the verifier CPI once the
//! compliance key is rotated (see `rotate_compliance_key`) -- the error
//! surfaced on-chain is the verifier program's own rejection code, not
//! `ComplianceKeyStale` (see `verify.rs`'s module docs for why a CPI
//! failure can never be remapped by the caller).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum PoolInstruction {
    /// authority(signer,payer), pool(pda,w), system_program
    ///
    /// `genesis_leaf`: computed off-chain by the client with Poseidon2 per
    /// spec §3.5/I-5 (`genesisLeaf(genesis_hash_of_cluster)`); the program
    /// only checks it is nonzero (same "leaf 0 rejected" rule as every
    /// other leaf) and inserts it as leaf 0. Deviation from the original
    /// I-3 signature (which had no such parameter and no way for the
    /// program to obtain the cluster genesis hash itself -- Solana exposes
    /// no such sysvar): this argument was added to close that gap.
    Initialize {
        compliance_pk_x: [u8; 32],
        compliance_pk_y: [u8; 32],
        verifiers: [Pubkey; 7],
        genesis_leaf: [u8; 32],
    },
    /// authority(signer), pool(w)
    SetVerifier { circuit_id: u8, program: Pubkey },
    /// authority(signer), pool(w)
    RotateComplianceKey { x: [u8; 32], y: [u8; 32] },
    /// authority(signer), pool(w)
    SetPaused { paused: bool },
    /// depositor(signer,payer), pool(w), asset(pda,w), mint, vault(w),
    /// depositor_token_account(w), token_program, associated_token_program,
    /// system_program; remaining[0] = verifier program for circuit 0.
    /// `public_inputs` (11): leaf, eph_pub_x, value, asset_id, ct0..6.
    /// No root (deposit has none). `proof`: compressed, see module docs.
    Deposit {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        amount: u64,
    },
    /// payer(signer), pool(w), nullifier(pda,w), system_program;
    /// remaining[0] = verifier program for circuit 1. `public_inputs` (21):
    /// nullifier, memo_leaf, memo_eph_x, memo_tag, memo_cek_wrap, memo_ct0..6,
    /// change_leaf, change_eph_x, change_ct0..6.
    Transfer {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        root_index: u8,
    },
    /// same shape as Transfer; remaining[0] = verifier program for circuit 3
    TransferMultisig {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        root_index: u8,
    },
    /// same accounts as Transfer; remaining[0] = verifier program for circuit 4.
    /// `public_inputs` (19): nullifier, out1_leaf, out1_eph_x, out1_ct0..6,
    /// out2_leaf, out2_eph_x, out2_ct0..6.
    SplitMultisig {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        root_index: u8,
    },
    /// payer(signer), pool(w), nullifier_a(pda,w), nullifier_b(pda,w),
    /// system_program; remaining[0] = verifier program for circuit 5.
    /// `public_inputs` (11): nullifier_a, nullifier_b, out_leaf, out_eph_x,
    /// out_ct0..6. (Original I-1 ordering has one root, at index 4.)
    JoinMultisig {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        root_index: u8,
    },
    /// payer(signer), pool(w), nullifier(pda,w), asset(r), vault(w),
    /// destination_token_account(w), token_program, system_program;
    /// remaining[0] = verifier program for circuit 2. `public_inputs` (14):
    /// value, recipient, intent_hash, nullifier, asset_id, change_leaf,
    /// change_eph_x, change_ct0..6.
    Withdraw {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        amount: u64,
        root_index: u8,
    },
    /// same shape as Withdraw; remaining[0] = verifier program for circuit 6
    WithdrawMultisig {
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
        amount: u64,
        root_index: u8,
    },
    /// Dev/test only: CPIs straight into `pool.verifiers[circuit_id]` with no
    /// nullifier/root/leaf side effects, so integration tests can exercise
    /// the real CPI wire format (`proof ‖ 12-byte gnark witness header ‖
    /// public_inputs`) against a real Sunspot verifier binary without
    /// needing a matching root/leaf state in the pool. `proof` is the
    /// compressed 192-byte form like every other ix (decompressed on-chain
    /// before the CPI); `public_inputs` is the FULL, uninjected input array
    /// (this ix does no cpk/root splicing -- it is a raw verifier probe).
    /// Kept at a fixed enum position (append-only) so the wire tag of every
    /// other variant never shifts regardless of the `dev-verify` feature;
    /// the processor only *handles* it when built with `--features
    /// dev-verify` (never in a release build -- see `processor.rs`).
    /// authority(signer), pool(r); remaining[0] = verifier program for
    /// `circuit_id`.
    VerifyOnly {
        circuit_id: u8,
        proof: [u8; 192],
        public_inputs: Vec<[u8; 32]>,
    },
}
