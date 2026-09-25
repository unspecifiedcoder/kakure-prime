mod mutation_tests;

use ::ecdh::Point;
use ::shared::{conservation, mint, open_multisig_note, TREE_DEPTH};
use ::shared::frost::{msg_withdraw, verify_frost_spend};
use ::shared::note::{assert_parents_bound, Note};
use ::shared::test_fixtures::{FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y};

fn main(
    withdraw_value: pub u128,
    recipient: pub Field,
    intent_hash: pub Field,
    compliance_pubkey_x: pub Field,
    compliance_pubkey_y: pub Field,
    gpk: Point,
    frost_r: Point,
    frost_z: Field,
    old_note: Note,
    old_note_index: Field,
    old_note_path: [Field; TREE_DEPTH],
    change_note: Note,
    change_eph: Field,
) -> pub (Field, Field, Field, Field, Field, [Field; 7]) {
    let compliance_pk = Point { x: compliance_pubkey_x, y: compliance_pubkey_y };
    mint::assert_valid_compliance_pk(compliance_pk);

    let (nullifier, computed_root) =
        open_multisig_note(old_note, gpk, old_note_index, old_note_path);

    assert(old_note.asset_id == change_note.asset_id, "asset mismatch");
    conservation::assert_conserved([old_note.value], [change_note.value], withdraw_value);
    assert_parents_bound(change_note, [old_note_index, 0]);

    let change = mint::mint_self_note_multisig(change_note, change_eph, compliance_pk, gpk);

    let m = msg_withdraw(
        computed_root,
        nullifier,
        change.leaf,
        withdraw_value as Field,
        old_note.asset_id,
        recipient,
        intent_hash,
    );
    verify_frost_spend(gpk, frost_r, frost_z, m);

    (nullifier, computed_root, old_note.asset_id, change.leaf, change.eph_pub.x, change.ciphertext)
}

global CX: Field = FIXTURE_COMPLIANCE_X;
global CY: Field = FIXTURE_COMPLIANCE_Y;
global ASSET_ID: Field = 0x1234567890123456789012345678901234567890;

fn kat_gpk() -> Point {
    Point {
        x: 0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764d,
        y: 0x0d7a564269d3675f75799ee9d7574b00d01190b243041994c0e460af507a71aa,
    }
}

fn gpk_owner() -> Field {
    let g = kat_gpk();
    poseidon::poseidon2::Poseidon2::hash([g.x, g.y], 2)
}

fn dummy_r() -> Point {
    Point {
        x: 0x262d28e21d283e57d8add3efde5b0ef36d18af221efa12d686b50fdae23c0b53,
        y: 0x20dba1d0aa62eab7f32a1a9eb2f4cb382080c3ea369f7422f9e27c075b9db09d,
    }
}

fn ms_input(value: u128) -> Note {
    Note {
        note_version: 1,
        asset_id: ASSET_ID,
        note_type: 1,
        conditions_hash: 0,
        value,
        owner: gpk_owner(),
        psi: 0x0981a88f9e119b057498a4ab99ed5379a1ea91c642454fc0c07aacc1f5cd5731,
        parents: 0,
    }
}

fn out_note(value: u128, note_type: Field, owner: Field, psi: Field) -> Note {
    Note {
        note_version: 1,
        asset_id: ASSET_ID,
        note_type,
        conditions_hash: 0,
        value,
        owner,
        psi,
        parents: 0,
    }
}

#[test(should_fail_with = "multisig change/self must be owned by the account gpk")]
fn audit_reject_off_gpk_change_owner() {
    let _ = main(
        40,
        0,
        0,
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(60, 1, gpk_owner() + 1, 0),
        8,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_2() {
    let _ = main(
        40,
        0,
        0,
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(60, 2, gpk_owner(), 0),
        8,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_standard() {
    let _ = main(
        40,
        0,
        0,
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(60, 0, gpk_owner(), 0),
        8,
    );
}

// Real 3-of-5 FROST witness from the TS signer (gen-withdraw-multisig-kat); accept parity.
global KAT_OLD_VALUE: u128 = 1000;
global KAT_WITHDRAW_VALUE: u128 = 300;
global KAT_CHANGE_VALUE: u128 = 700;
global KAT_RECIPIENT: Field = 0x00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee;
global KAT_INTENT_HASH: Field = 0;
global KAT_CHANGE_EPH: Field = 4;
// regenerated for kakure.* domains (circuits/scripts/gen_frost_kats.ts)
global KAT_CHANGE_PSI: Field = 0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e;
global KAT_FROST_Z: Field = 0x0539c7129b44ac4879eec24474ca0f9f2adaca99ecba33b8790d49e7fd1cb9dd;

fn kat_frost_r() -> Point {
    Point {
        x: 0x226a56539c3ebe71843fad8000257cb9cddc7be6988bcbd3cb535e5a2660a7bb,
        y: 0x1798200f2ceee218cff9851c058dbe6e4d3c2e1362417eadb8b069d283ce5062,
    }
}

#[test]
fn kat_multisig_withdraw_accepts() {
    let _ = main(
        KAT_WITHDRAW_VALUE,
        KAT_RECIPIENT,
        KAT_INTENT_HASH,
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        ms_input(KAT_OLD_VALUE),
        0,
        [0; TREE_DEPTH],
        out_note(KAT_CHANGE_VALUE, 1, gpk_owner(), KAT_CHANGE_PSI),
        KAT_CHANGE_EPH,
    );
}

#[test(should_fail_with = "FROST signature invalid")]
fn audit_reject_mutated_signed_recipient() {
    let _ = main(
        KAT_WITHDRAW_VALUE,
        KAT_RECIPIENT + 1,
        KAT_INTENT_HASH,
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        ms_input(KAT_OLD_VALUE),
        0,
        [0; TREE_DEPTH],
        out_note(KAT_CHANGE_VALUE, 1, gpk_owner(), KAT_CHANGE_PSI),
        KAT_CHANGE_EPH,
    );
}
