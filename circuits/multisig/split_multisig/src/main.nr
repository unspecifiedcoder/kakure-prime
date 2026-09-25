mod mutation_tests;

use ::ecdh::Point;
use ::shared::{conservation, mint, open_multisig_note, TREE_DEPTH};
use ::shared::frost::{msg_split, verify_frost_spend};
use ::shared::note::{assert_parents_bound, Note};
use ::shared::test_fixtures::{FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y};

fn main(
    compliance_pubkey_x: pub Field,
    compliance_pubkey_y: pub Field,
    gpk: Point,
    frost_r: Point,
    frost_z: Field,
    note_in: Note,
    index_in: Field,
    path_in: [Field; TREE_DEPTH],
    note_out_1: Note,
    eph_1: Field,
    note_out_2: Note,
    eph_2: Field,
) -> pub (Field, Field, Field, Field, [Field; 7], Field, Field, [Field; 7]) {
    let compliance_pk = Point { x: compliance_pubkey_x, y: compliance_pubkey_y };
    mint::assert_valid_compliance_pk(compliance_pk);

    let (nullifier, computed_root) = open_multisig_note(note_in, gpk, index_in, path_in);

    assert(note_in.asset_id == note_out_1.asset_id, "out1 asset mismatch");
    assert(note_in.asset_id == note_out_2.asset_id, "out2 asset mismatch");
    assert(eph_1 != eph_2, "ephemerals must be distinct");
    conservation::assert_conserved([note_in.value], [note_out_1.value, note_out_2.value], 0);
    assert_parents_bound(note_out_1, [index_in, 0]);
    assert_parents_bound(note_out_2, [index_in, 0]);

    let out1 = mint::mint_self_note_multisig(note_out_1, eph_1, compliance_pk, gpk);
    let out2 = mint::mint_self_note_multisig(note_out_2, eph_2, compliance_pk, gpk);

    let m = msg_split(
        computed_root,
        nullifier,
        out1.leaf,
        out2.leaf,
        note_in.asset_id,
    );
    verify_frost_spend(gpk, frost_r, frost_z, m);

    (
        nullifier, computed_root, out1.leaf, out1.eph_pub.x, out1.ciphertext, out2.leaf,
        out2.eph_pub.x, out2.ciphertext,
    )
}

global CX: Field = FIXTURE_COMPLIANCE_X;
global CY: Field = FIXTURE_COMPLIANCE_Y;
global ASSET_ID: Field = 0x1234567890123456789012345678901234567890;
// regenerated for kakure.* domains: must equal note_nullifier::psi(derive_cek(15, compliance_pk)).
global OUT1_PSI: Field = 0x23dab893686fe541a00c7da429606b1ba90e17b7b1a3da8f35a627671851701c;

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
fn audit_reject_off_gpk_change_owner_out1() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(40, 1, gpk_owner() + 1, 0),
        15,
        out_note(60, 1, gpk_owner(), 0),
        20,
    );
}

#[test(should_fail_with = "multisig change/self must be owned by the account gpk")]
fn audit_reject_off_gpk_change_owner_out2() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(40, 1, gpk_owner(), OUT1_PSI),
        15,
        out_note(60, 1, gpk_owner() + 1, 0),
        20,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_2() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(40, 2, gpk_owner(), 0),
        15,
        out_note(60, 1, gpk_owner(), 0),
        20,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_standard() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        dummy_r(),
        1,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(40, 0, gpk_owner(), 0),
        15,
        out_note(60, 1, gpk_owner(), 0),
        20,
    );
}

// Real 3-of-5 FROST witness from the TS signer (gen-split-multisig-kat); accept parity.
// regenerated for kakure.* domains (circuits/scripts/gen_frost_kats.ts)
global KAT_PSI1: Field = 0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e;
global KAT_PSI2: Field = 0x1a72e6c3463dd2509150c482ad772ede1290d453977279eed05f10ae8cbd75f0;
global KAT_FROST_Z: Field = 0x03a8e30852fa2baefee63c855367313bd1c905de91dc5e35715f1e965a3b028c;

fn kat_frost_r() -> Point {
    Point {
        x: 0x113d2db340a6faa752b7a09078291d4622b6b525b116efbdf30476066530609b,
        y: 0x125394afe74a84bbd487ba7124deec6befa16af106de43e5d2b4495aff388d98,
    }
}

#[test]
fn kat_multisig_split_accepts() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(60, 1, gpk_owner(), KAT_PSI1),
        4,
        out_note(40, 1, gpk_owner(), KAT_PSI2),
        5,
    );
}

// value swap keeps conservation (61+39==100) but shifts the signed leaves -> FROST rejects
#[test(should_fail_with = "FROST signature invalid")]
fn audit_reject_mutated_signed_value() {
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        ms_input(100),
        0,
        [0; TREE_DEPTH],
        out_note(61, 1, gpk_owner(), KAT_PSI1),
        4,
        out_note(39, 1, gpk_owner(), KAT_PSI2),
        5,
    );
}
