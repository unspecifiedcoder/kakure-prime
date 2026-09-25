mod mutation_tests;

use ::ecdh::Point;
use ::shared::{conservation, mint, open_multisig_note, TREE_DEPTH};
use ::shared::frost::{msg_join, verify_frost_spend};
use ::shared::note::{assert_parents_bound, Note};
use ::shared::test_fixtures::{FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y};

fn main(
    compliance_pubkey_x: pub Field,
    compliance_pubkey_y: pub Field,
    gpk_a: Point,
    frost_r_a: Point,
    frost_z_a: Field,
    note_a: Note,
    index_a: Field,
    path_a: [Field; TREE_DEPTH],
    gpk_b: Point,
    frost_r_b: Point,
    frost_z_b: Field,
    note_b: Note,
    index_b: Field,
    path_b: [Field; TREE_DEPTH],
    note_out: Note,
    eph_out: Field,
) -> pub (Field, Field, Field, Field, Field, [Field; 7]) {
    let compliance_pk = Point { x: compliance_pubkey_x, y: compliance_pubkey_y };
    mint::assert_valid_compliance_pk(compliance_pk);

    let (nullifier_a, root_a) = open_multisig_note(note_a, gpk_a, index_a, path_a);
    let (nullifier_b, root_b) = open_multisig_note(note_b, gpk_b, index_b, path_b);
    assert(root_a == root_b, "inputs must share a root");
    assert(nullifier_a != nullifier_b, "cannot join a note with itself");
    // verify_spend's to_le_bits::<TREE_DEPTH> already range-bound both indexes, so the u32 compare is exact.
    assert((index_a as u32) < (index_b as u32), "join inputs must be strictly index-ordered");

    // Cross-account join is barred: with an unbound output owner either signer could redirect the merged value.
    assert((gpk_a.x == gpk_b.x) & (gpk_a.y == gpk_b.y), "join inputs must share one account gpk");

    assert(note_a.asset_id == note_b.asset_id, "input asset mismatch");
    assert(note_a.asset_id == note_out.asset_id, "output asset mismatch");
    conservation::assert_conserved([note_a.value, note_b.value], [note_out.value], 0);
    assert_parents_bound(note_out, [index_a, index_b]);

    let out = mint::mint_self_note_multisig(note_out, eph_out, compliance_pk, gpk_a);

    let m = msg_join(root_a, nullifier_a, nullifier_b, out.leaf, note_a.asset_id);
    verify_frost_spend(gpk_a, frost_r_a, frost_z_a, m);
    verify_frost_spend(gpk_b, frost_r_b, frost_z_b, m);

    (nullifier_a, nullifier_b, root_a, out.leaf, out.eph_pub.x, out.ciphertext)
}

global CX: Field = FIXTURE_COMPLIANCE_X;
global CY: Field = FIXTURE_COMPLIANCE_Y;
global ASSET_ID: Field = 0x1234567890123456789012345678901234567890;

// GPK/nonce/z regenerated for the kakure.* domain rename (msg_join is signed over
// SCHNORR_DOMAIN/ACTION_JOIN, so the old signature no longer verifies). sk/k are throwaway
// scratch secrets; see circuits/scripts/gen_frost_kats.ts and circuits/PROVENANCE.md.
// z = (k + e*sk) mod BabyJubJub subgroup order.
fn kat_gpk() -> Point {
    Point {
        x: 0x2d82800a43db9d116f24ad0c55a47245a21a7a3f7c4e037ca042e050ec6cf9aa,
        y: 0x2ba8801e190e114ac7342201543f4333560bb7cffa3a6cf383f7abc0cb0437c4,
    }
}

fn gpk_owner() -> Field {
    let g = kat_gpk();
    poseidon::poseidon2::Poseidon2::hash([g.x, g.y], 2)
}

fn gpk_b() -> Point {
    Point {
        x: 0x262d28e21d283e57d8add3efde5b0ef36d18af221efa12d686b50fdae23c0b53,
        y: 0x20dba1d0aa62eab7f32a1a9eb2f4cb382080c3ea369f7422f9e27c075b9db09d,
    }
}

fn join_input(value: u128, owner: Field, psi: Field) -> Note {
    Note {
        note_version: 1,
        asset_id: ASSET_ID,
        note_type: 1,
        conditions_hash: 0,
        value,
        owner,
        psi,
        parents: 0,
    }
}

fn out_note(note_type: Field, owner: Field) -> Note {
    Note {
        note_version: 1,
        asset_id: ASSET_ID,
        note_type,
        conditions_hash: 0,
        value: 150,
        owner,
        psi: 0,
        parents: 0x100000000,
    }
}

#[test(should_fail_with = "multisig change/self must be owned by the account gpk")]
fn audit_reject_off_gpk_change_owner() {
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, gpk_owner(), 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        gpk_b(),
        1,
        note_a,
        0,
        path_a,
        kat_gpk(),
        gpk_b(),
        1,
        note_b,
        1,
        path_b,
        out_note(1, gpk_owner() + 1),
        28,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_2() {
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, gpk_owner(), 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        gpk_b(),
        1,
        note_a,
        0,
        path_a,
        kat_gpk(),
        gpk_b(),
        1,
        note_b,
        1,
        path_b,
        out_note(2, gpk_owner()),
        28,
    );
}

#[test(should_fail_with = "multisig self note must be MULTISIG")]
fn audit_reject_out_note_type_standard() {
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, gpk_owner(), 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        gpk_b(),
        1,
        note_a,
        0,
        path_a,
        kat_gpk(),
        gpk_b(),
        1,
        note_b,
        1,
        path_b,
        out_note(0, gpk_owner()),
        28,
    );
}

#[test(should_fail_with = "join inputs must share one account gpk")]
fn audit_reject_cross_account_gpk() {
    let b = gpk_b();
    let owner_b = poseidon::poseidon2::Poseidon2::hash([b.x, b.y], 2);
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, owner_b, 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        gpk_b(),
        1,
        note_a,
        0,
        path_a,
        gpk_b(),
        gpk_b(),
        1,
        note_b,
        1,
        path_b,
        out_note(1, gpk_owner()),
        28,
    );
}

// Single-signer FROST witness (t=1 threshold degenerates to plain Schnorr), regenerated for the
// Poseidon v1 tree hash by circuits/multisig/join_multisig/src/gen_kat_scratch.nr (removed after
// generating these constants; see git history / circuits/PROVENANCE.md).
global KAT_PSI_OUT: Field = 0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e;
global KAT_FROST_Z: Field = 0x05b60f70529d4adad602876c78271239c9ce6cd42d504f8cdee9eae60ec41af6;

fn kat_frost_r() -> Point {
    Point {
        x: 0x21d5007e0bf34c290e7a50e0f0d8248180426b95e1e9e2ed9ba7598938cb3178,
        y: 0x0b6da08df6903dca3ffb83ffb421a753bfe983cd9e62ccbff244f906cbbc2813,
    }
}

fn kat_out_note() -> Note {
    Note {
        note_version: 1,
        asset_id: ASSET_ID,
        note_type: 1,
        conditions_hash: 0,
        value: 150,
        owner: gpk_owner(),
        psi: KAT_PSI_OUT,
        parents: 0x100000000,
    }
}

#[test]
fn kat_multisig_join_accepts() {
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, gpk_owner(), 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        note_a,
        0,
        path_a,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        note_b,
        1,
        path_b,
        kat_out_note(),
        4,
    );
}

#[test(should_fail_with = "FROST signature invalid")]
fn audit_reject_mutated_signed_z_b() {
    let note_a = join_input(100, gpk_owner(), 0x01);
    let note_b = join_input(50, gpk_owner(), 0x02);
    let mut path_a = [0; TREE_DEPTH];
    path_a[0] = note_b.leaf();
    let mut path_b = [0; TREE_DEPTH];
    path_b[0] = note_a.leaf();
    let _ = main(
        CX,
        CY,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z,
        note_a,
        0,
        path_a,
        kat_gpk(),
        kat_frost_r(),
        KAT_FROST_Z + 1,
        note_b,
        1,
        path_b,
        kat_out_note(),
        4,
    );
}
