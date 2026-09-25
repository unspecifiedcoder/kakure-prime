use crate::kem;
use crate::mint;
use crate::note::Note;
use crate::test_fixtures::{fixture_compliance_pk, fixture_note};
use crate::TREE_DEPTH;
use crate::verify_spend;
use ecdh::Point;

global VALID_SCALAR: Field = 789;
// regenerated for kakure.* domains (fixture_note()'s psi moved)
global EXPECTED_ROOT: Field = 0x3056dd556d5cdd64264d91742bc7d8ee1af96c53e799c99244a2674498ba3f30;
global EXPECTED_NF: Field = 0x1b5a2970d07fa6183eed9bb0ab0fd7bec3e1681050e3f61f449e1ecdf96dddd9;

fn compliance() -> Point {
    fixture_compliance_pk()
}

fn valid_note() -> Note {
    fixture_note()
}

fn spend_at_zero(note: Note, scalar: Field, index: Field) -> (Field, Field) {
    verify_spend(note, scalar, index, [0; TREE_DEPTH])
}

#[test]
fn test_valid_spend_accepts() {
    let (nf, root) = spend_at_zero(valid_note(), VALID_SCALAR, 0);
    assert(nf == EXPECTED_NF);
    assert(root == EXPECTED_ROOT);
}

#[test(should_fail_with = "spender does not own this note")]
fn audit_wrong_spend_scalar_rejected() {
    let _ = spend_at_zero(valid_note(), 0x2a, 0);
}

#[test(should_fail_with = "spender does not own this note")]
fn audit_mutated_owner_rejected() {
    let mut note = valid_note();
    note.owner = 0xdeadbeef;
    let _ = spend_at_zero(note, VALID_SCALAR, 0);
}

#[test(should_fail)]
fn audit_mutated_psi_breaks_membership() {
    let mut note = valid_note();
    note.psi = note.psi + 1;
    let (_, root) = spend_at_zero(note, VALID_SCALAR, 0);
    assert(root == EXPECTED_ROOT);
}

#[test(should_fail_with = "unexpected note version")]
fn audit_wrong_note_version_rejected() {
    let mut note = valid_note();
    note.note_version = 2;
    let _ = spend_at_zero(note, VALID_SCALAR, 0);
}

#[test(should_fail_with = "unexpected note type")]
fn audit_wrong_note_type_rejected() {
    let mut note = valid_note();
    note.note_type = 1;
    let _ = spend_at_zero(note, VALID_SCALAR, 0);
}

#[test(should_fail_with = "non-canonical leaf index")]
fn audit_noncanonical_index_rejected() {
    let _ = spend_at_zero(valid_note(), VALID_SCALAR, 7);
}

// The empty-level assert above does not cover relocation: moving the honest sibling sequence into a different
// order-preserving choice of levels, with the index bits set to match, leaves no right child at an empty level.
// Only the level absorbed into every tree hash separates the two roots, and without it one note proves membership
// at many indexes while Poseidon2(psi, leaf_index) mints a fresh nullifier under each.
#[test]
fn audit_relocated_index_moves_root_and_nullifier() {
    let mut low = [0; TREE_DEPTH];
    low[0] = 7;
    low[1] = 11;
    let mut high = [0; TREE_DEPTH];
    high[2] = 7;
    high[3] = 11;
    let (nf_low, root_low) = verify_spend(valid_note(), VALID_SCALAR, 3, low);
    let (nf_high, root_high) = verify_spend(valid_note(), VALID_SCALAR, 12, high);
    assert(root_low != root_high, "relocated siblings reproduced the root");
    assert(nf_low != nf_high, "relocated index left the nullifier unchanged");
}

#[test(should_fail_with = "unexpected note version")]
fn audit_mint_wrong_version() {
    let mut note = valid_note();
    note.note_version = 2;
    let _ = mint::mint_self_note(note, 5, compliance());
}

#[test(should_fail_with = "self note must be STANDARD")]
fn audit_mint_wrong_type() {
    let mut note = valid_note();
    note.note_type = 1;
    let _ = mint::mint_self_note(note, 5, compliance());
}

#[test(should_fail_with = "psi not bound to CEK")]
fn audit_mint_unbound_psi_rejected() {
    let mut note = valid_note();
    note.psi = note.psi + 1;
    let _ = mint::mint_self_note(note, 5, compliance());
}

#[test(should_fail_with = "note owner must be non-zero")]
fn audit_mint_zero_owner_rejected() {
    let mut note = valid_note();
    note.owner = 0;
    let _ = mint::mint_self_note(note, 5, compliance());
}

#[test(should_fail_with = "note conditions_hash must be zero")]
fn audit_mint_nonzero_conditions_hash_rejected() {
    let mut note = valid_note();
    note.conditions_hash = 1;
    let _ = mint::mint_self_note(note, 5, compliance());
}

#[test(should_fail_with = "self discovery tag must be even-y")]
fn audit_mint_odd_y_tag_rejected() {
    let mut note = valid_note();
    // regenerated for kakure.* domains: must equal note_nullifier::psi(derive_cek(456, compliance_pk))
    note.psi = 0x1f33fe53db83297049bd83916d5c35eeff3cdd1a9cbb644c06441cd02d6d55cd;
    let _ = mint::mint_self_note(note, 456, compliance());
}

#[test]
fn test_cek_wrap_roundtrip() {
    let in_pub = Point {
        x: 0x158b1d9682257c0832785c20b002c360b7f84f59f253e667659cf90c1455f764,
        y: 0x132a0f65758b4775374cfc0a98d7f8a186e1cad626e4e4cd37b73532d7e50101,
    };
    let eph_pub = Point {
        x: 0x06263d32df3940b1135a6a6b85bd84ea1dc0e4746a15a5d204efffec30a18010,
        y: 0x13fdbd796de262a086329a56d29f53f98f8c9e52b16939652d27eeb9646efdd1,
    };
    let cek = 0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bda;
    let wrapped = kem::wrap_cek(cek, 456, in_pub);
    assert(kem::unwrap_cek(wrapped, 789, eph_pub) == cek);
    assert(kem::unwrap_cek(wrapped + 1, 789, eph_pub) != cek);
}
