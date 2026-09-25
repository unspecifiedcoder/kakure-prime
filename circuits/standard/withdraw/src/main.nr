mod mutation_tests;

use ::ecdh::Point;
use ::shared::{conservation, mint, TREE_DEPTH, verify_spend};
use ::shared::note::{assert_parents_bound, Note};
use ::shared::test_fixtures::{FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y, fixture_note};

fn main(
    withdraw_value: pub u128,
    recipient: pub Field,
    intent_hash: pub Field,
    compliance_pubkey_x: pub Field,
    compliance_pubkey_y: pub Field,
    old_note: Note,
    spend_scalar: Field,
    old_note_index: Field,
    old_note_path: [Field; TREE_DEPTH],
    change_note: Note,
    change_eph: Field,
) -> pub (Field, Field, Field, Field, Field, [Field; 7]) {
    let compliance_pk = Point { x: compliance_pubkey_x, y: compliance_pubkey_y };
    mint::assert_valid_compliance_pk(compliance_pk);

    // Bind the on-chain-checked public inputs into the constraint system. Under Groth16 an
    // unreferenced public wire has K[i] = infinity and is NOT bound by the proof (slice-2 F-1):
    // the verifier's sum over public inputs skips such a wire, so a value with zero occurrences
    // in A/B/C can be swapped by whoever relays the proof without invalidating it. `recipient !=
    // 0` forces an inverse constraint (`recipient * inv == 1`); `intent_hash == 0` forces a
    // direct equality constraint. Both therefore appear in the R1CS and are bound by the proof.
    assert(recipient != 0, "recipient must be nonzero");
    assert(intent_hash == 0, "intent_hash must be zero in v1");

    let (nullifier, computed_root) =
        verify_spend(old_note, spend_scalar, old_note_index, old_note_path);

    assert(old_note.asset_id == change_note.asset_id, "asset mismatch");
    conservation::assert_conserved([old_note.value], [change_note.value], withdraw_value);
    assert_parents_bound(change_note, [old_note_index, 0]);

    let change = mint::mint_self_note(change_note, change_eph, compliance_pk);

    (nullifier, computed_root, old_note.asset_id, change.leaf, change.eph_pub.x, change.ciphertext)
}

fn spent_note() -> Note {
    fixture_note()
}

// psi regenerated for kakure.* domains: must equal note_nullifier::psi(derive_cek(8, compliance_pk)).
fn change_note() -> Note {
    Note {
        note_version: 1,
        asset_id: 0x1234567890123456789012345678901234567890,
        note_type: 0,
        conditions_hash: 0,
        value: 60,
        owner: 0x2874ae964d8b283e2f521a7f14125fc92747bb9770139b8d4b70ee09e2d83785,
        psi: 0x1e06ec4b4877317f82d92c39e35a562ee9f9dfedb6fcd3fee5ef9eb27ba0b764,
        parents: 0,
    }
}

fn compliance() -> (Field, Field) {
    (FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y)
}

// TS/Noir/Solidity parity golden
// regenerated for kakure.* domains (fixture_note()'s psi and its dependents moved)
#[test]
fn test_withdraw_kat() {
    let (cx, cy) = compliance();
    let (nf, root, asset, change_leaf, epk_x, ct) = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        change_note(),
        8,
    );
    assert(nf == 0x1b5a2970d07fa6183eed9bb0ab0fd7bec3e1681050e3f61f449e1ecdf96dddd9);
    assert(root == 0x3056dd556d5cdd64264d91742bc7d8ee1af96c53e799c99244a2674498ba3f30);
    assert(asset == 0x1234567890123456789012345678901234567890);
    assert(change_leaf == 0x28be4aa5a4b52186ee17245d65e6b76a67594a1bc72b2664a0b2a7ac69ade5de);
    assert(epk_x == 0x10c347ae3592776a678f9fc29ecd029f8297367209a4f28f7cb49b09bffd4145);
    assert(ct[0] == 0x2e80675fcfa51c59fcb391b2609516114610d3200eb5d8007ae8a302e99540c5);
}

#[test(should_fail_with = "spender does not own this note")]
fn audit_reject_wrong_spender() {
    let (cx, cy) = compliance();
    let _ = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        0x2a,
        0,
        [0; TREE_DEPTH],
        change_note(),
        8,
    );
}

#[test(should_fail_with = "value not conserved")]
fn audit_reject_value_inflation() {
    let (cx, cy) = compliance();
    let mut inflated = change_note();
    inflated.value = 100;
    let _ = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        inflated,
        8,
    );
}

#[test(should_fail_with = "output parents not bound to consumed inputs")]
fn audit_reject_forged_change_parents() {
    let (cx, cy) = compliance();
    let mut change = change_note();
    change.parents = 0x100000000;
    let _ = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        change,
        8,
    );
}

#[test(should_fail_with = "asset mismatch")]
fn audit_reject_change_asset_mismatch() {
    let (cx, cy) = compliance();
    let mut change = change_note();
    change.asset_id = 0x00000000000000000000000000000000000000ff;
    let _ = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        change,
        8,
    );
}

#[test(should_fail)]
fn audit_reject_non_membership() {
    let (cx, cy) = compliance();
    let mut path = [0; TREE_DEPTH];
    path[0] = 0x0abc;
    let (_, root, _, _, _, _) = main(
        40,
        0x1234567890123456789012345678901234567890,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        path,
        change_note(),
        8,
    );
    assert(root == 0x3056dd556d5cdd64264d91742bc7d8ee1af96c53e799c99244a2674498ba3f30);
}

#[test(should_fail_with = "recipient must be nonzero")]
fn audit_reject_zero_recipient() {
    let (cx, cy) = compliance();
    let _ = main(
        40,
        0,
        0,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        change_note(),
        8,
    );
}

#[test(should_fail_with = "intent_hash must be zero in v1")]
fn audit_reject_nonzero_intent_hash() {
    let (cx, cy) = compliance();
    let _ = main(
        40,
        0x1234567890123456789012345678901234567890,
        1,
        cx,
        cy,
        spent_note(),
        789,
        0,
        [0; TREE_DEPTH],
        change_note(),
        8,
    );
}
