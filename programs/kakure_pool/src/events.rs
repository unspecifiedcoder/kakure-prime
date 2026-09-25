//! Events (frozen interface I-4).
//!
//! Deviation: Anchor is unavailable on this toolchain, so there is no
//! `emit_cpi!`. Events are emitted with `sol_log_data` (the same primitive
//! Anchor's `emit!` uses) under a fixed string tag so the indexer (E) can
//! filter program logs by tag and borsh-decode the remaining bytes. This
//! does not have `emit_cpi!`'s log-truncation immunity; flagged for E to
//! confirm log sizes stay under the ~10KB per-tx log budget (in practice
//! each event carries at most 24 32-byte fields plus a leaf index/root, well
//! under that limit).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::log::sol_log_data;

pub const NOTE_INSERTED_TAG: &str = "kakure:NoteInserted";
pub const NULLIFIER_SPENT_TAG: &str = "kakure:NullifierSpent";
pub const COMPLIANCE_KEY_ROTATED_TAG: &str = "kakure:ComplianceKeyRotated";

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct NoteInserted {
    pub leaf_index: u64,
    pub leaf: [u8; 32],
    pub eph_pub_x: [u8; 32],
    pub tag: Option<[u8; 32]>,
    pub cek_wrap: Option<[u8; 32]>,
    pub ciphertext: [[u8; 32]; 7],
    pub root: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct NullifierSpentEvent {
    pub nullifier: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct ComplianceKeyRotated {
    pub old_version: u32,
    pub new_version: u32,
    pub x: [u8; 32],
    pub y: [u8; 32],
}

pub fn emit_note_inserted(ev: &NoteInserted) {
    let bytes = borsh::to_vec(ev).expect("borsh serialize NoteInserted");
    sol_log_data(&[NOTE_INSERTED_TAG.as_bytes(), &bytes]);
}

pub fn emit_nullifier_spent(nullifier: [u8; 32]) {
    let bytes = borsh::to_vec(&NullifierSpentEvent { nullifier }).expect("borsh serialize NullifierSpent");
    sol_log_data(&[NULLIFIER_SPENT_TAG.as_bytes(), &bytes]);
}

pub fn emit_compliance_key_rotated(ev: &ComplianceKeyRotated) {
    let bytes = borsh::to_vec(ev).expect("borsh serialize ComplianceKeyRotated");
    sol_log_data(&[COMPLIANCE_KEY_ROTATED_TAG.as_bytes(), &bytes]);
}
