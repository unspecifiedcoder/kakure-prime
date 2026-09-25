use crate::assert_subgroup_scalar;
use crate::domains::{ACTION_JOIN, ACTION_SPLIT, ACTION_TRANSFER, ACTION_WITHDRAW, SCHNORR_DOMAIN};
use ecdh::{bjj::BJJ, ECDHTrait, Point};
use edwards::{bjj::BabyJubJub, CurveTrait, ScalarField};
use poseidon::poseidon2::Poseidon2;

pub fn verify_frost_spend(gpk: Point, r: Point, z: Field, m: Field) {
    let gpk_ed = BabyJubJub::new(gpk.x, gpk.y);
    crate::subgroup::assert_in_prime_subgroup(gpk, "gpk not in prime-order subgroup");
    assert(!gpk_ed.is_zero(), "gpk must not be the identity");

    let r_ed = BabyJubJub::new(r.x, r.y);
    r_ed.assert_is_on_curve();
    assert(!r_ed.is_zero(), "R must not be the identity");

    assert_subgroup_scalar(z);

    // Challenge truncated to 248 bits so the ScalarField<63> path decodes it; its `assert(acc - skew == x)`
    // binds the wNAF hint to e. Upstream noir-edwards v0.2.5 left N==64 unbound (#49); the vendored fork binds it.
    let e_full = Poseidon2::hash([SCHNORR_DOMAIN, r.x, r.y, gpk.x, gpk.y, m], 6);
    let e_bytes: [u8; 32] = e_full.to_le_bytes();
    let mut e: Field = 0;
    let mut pow: Field = 1;
    for i in 0..31 {
        e += (e_bytes[i] as Field) * pow;
        pow *= 256;
    }
    let e_scalar: ScalarField<63> = ScalarField::from(e);

    let z_base = BJJ::new(z).derive_public_key();
    let z_base_ed = BabyJubJub::new(z_base.x, z_base.y);

    let rhs = r_ed + gpk_ed.mul(e_scalar);
    let diff = z_base_ed - rhs;
    let cofactored = diff.dbl().dbl().dbl();
    assert(cofactored.is_zero(), "FROST signature invalid");
}

// Distinct ACTION tag per op stops cross-op replay. Mirrored byte-for-byte by the TS FROST signer.

pub fn msg_withdraw(
    root: Field,
    nullifier: Field,
    change_leaf: Field,
    public_out: Field,
    asset: Field,
    recipient: Field,
    intent_hash: Field,
) -> Field {
    Poseidon2::hash(
        [ACTION_WITHDRAW, root, nullifier, change_leaf, public_out, asset, recipient, intent_hash],
        8,
    )
}

// Signing memo_tag stops a coordinator re-proving the quorum sig against a substituted view key.
pub fn msg_transfer(
    root: Field,
    nullifier: Field,
    memo_leaf: Field,
    memo_tag: Field,
    change_leaf: Field,
    asset: Field,
) -> Field {
    Poseidon2::hash(
        [ACTION_TRANSFER, root, nullifier, memo_leaf, memo_tag, change_leaf, asset],
        7,
    )
}

pub fn msg_split(
    root: Field,
    nullifier: Field,
    out1_leaf: Field,
    out2_leaf: Field,
    asset: Field,
) -> Field {
    Poseidon2::hash(
        [ACTION_SPLIT, root, nullifier, out1_leaf, out2_leaf, asset],
        6,
    )
}

pub fn msg_join(
    root: Field,
    nullifier_a: Field,
    nullifier_b: Field,
    out_leaf: Field,
    asset: Field,
) -> Field {
    Poseidon2::hash(
        [ACTION_JOIN, root, nullifier_a, nullifier_b, out_leaf, asset],
        6,
    )
}

// Real 3-of-5 FROST signature from the TS signer (gen-frost-kat).
// regenerated for kakure.* domains (SCHNORR_DOMAIN moved; gpk is unaffected)
fn kat_gpk() -> Point {
    Point {
        x: 0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764d,
        y: 0x0d7a564269d3675f75799ee9d7574b00d01190b243041994c0e460af507a71aa,
    }
}
fn kat_r() -> Point {
    Point {
        x: 0x1f2290f4eabfc9f6bee4d67916231d3d08c31b78de159c9212fe9bf0371ec094,
        y: 0x1bccaf427b6b2e0819ae1b69e06ee52f9641b698dbb34dd5f7c56594708a226d,
    }
}
global KAT_Z: Field = 0x05b830d053ab8ba988e76ff32e9fbad4be651fcd5d9405e6f12c9b612800df54;
global KAT_M: Field = 0x00abcdef1234567890fedcba9876543210abcdef1234567890fedcba98765432;

#[test]
fn kat_frost_verify_accepts() {
    verify_frost_spend(kat_gpk(), kat_r(), KAT_Z, KAT_M);
}

#[test(should_fail_with = "FROST signature invalid")]
fn audit_frost_reject_mutated_z() {
    verify_frost_spend(kat_gpk(), kat_r(), KAT_Z + 1, KAT_M);
}

#[test(should_fail_with = "FROST signature invalid")]
fn audit_frost_reject_mutated_message() {
    verify_frost_spend(kat_gpk(), kat_r(), KAT_Z, KAT_M + 1);
}

#[test(should_fail_with = "FROST signature invalid")]
fn audit_frost_reject_substituted_gpk() {
    verify_frost_spend(kat_r(), kat_r(), KAT_Z, KAT_M);
}

#[test(should_fail_with = "scalar must be non-zero")]
fn audit_frost_reject_zero_z() {
    verify_frost_spend(kat_gpk(), kat_r(), 0, KAT_M);
}

// Forging e_scalar is a proving-layer attack nargo cannot reach; see the bb.js forgery harness.
#[test]
fn frost_challenge_is_truncated_to_248_bits() {
    let g = kat_gpk();
    let r = kat_r();
    let e_full = Poseidon2::hash([SCHNORR_DOMAIN, r.x, r.y, g.x, g.y, KAT_M], 6);
    let e_bytes: [u8; 32] = e_full.to_le_bytes();
    let mut e: Field = 0;
    let mut pow: Field = 1;
    for i in 0..31 {
        e += (e_bytes[i] as Field) * pow;
        pow *= 256;
    }
    let e_le: [u8; 32] = e.to_le_bytes();
    assert(e_le[31] == 0, "FROST challenge not truncated to 248 bits");
}

// TS<->Noir parity lock on the FROST message layout (sdk gen-m-kat).
// regenerated for kakure.* domains (SCHNORR_DOMAIN/ACTION_* moved)
#[test]
fn kat_msg_parity() {
    assert(
        msg_withdraw(1, 2, 3, 4, 5, 6, 7)
            == 0x21f66081a6ec294ce6d480cc98829c7170174caf9bc789b9b0ca9e47951e87c1,
    );
    assert(
        msg_transfer(1, 2, 3, 4, 5, 6)
            == 0x123055eca632774fa61023ad17634974d6e92a54a1007444ffde6d4235c8dcf6,
    );
    assert(
        msg_split(1, 2, 3, 4, 5)
            == 0x2da48727cf45aa5d2365949fc63a30c31a237f433b1d28a0ba8ae5f84024ba52,
    );
    assert(
        msg_join(1, 2, 3, 4, 5)
            == 0x0f88a1c9580cc6394442ea59bdb3f8cd26a55da6e8d81e3cac6a90d012b4c125,
    );
}
