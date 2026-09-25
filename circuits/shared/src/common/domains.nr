// keccak256("kakure.enc.v1") % BN254_Fr
pub global ENC_DOMAIN: Field = 0x23f955e41a1c10e85986f4fb49fcaf4cb8a6d3264f10fd0253d5e212303b9882;
// keccak256("kakure.psi.v1") % BN254_Fr
pub global PSI_DOMAIN: Field = 0x20b80b02c7b72d50c3f3dbdb4aa38592cdac5c1aa0f9d3f3509480ae234a790;

// keccak256("kakure.frost.v1") % BN254_Fr
pub global SCHNORR_DOMAIN: Field = 0xc226e4b2bad84dcd0be5f5cc5c4334b8906fc9057331061d0b5b6117c74c667;

// keccak256("kakure.frost.action.<op>.v1") % BN254_Fr
pub global ACTION_WITHDRAW: Field =
    0x61c32c849432c5cb181c8aff85b048edfe720f4d14f9330a19892e6b3f2858e;
pub global ACTION_TRANSFER: Field =
    0x1547047254eb19dda78a0a366ebb6a91dc073c5396d00f1d32a4afbea2ca1b5d;
pub global ACTION_SPLIT: Field = 0xda9aecde0fd0366b1cc6070cd943bffd9cdc2bece458fe66a67881019937b18;
pub global ACTION_JOIN: Field = 0x8d2a589888a5903aeb21e14836db1b3d9adb31de0dd29fb5103978815f30223;

#[test]
fn audit_domains_pairwise_distinct() {
    let tags = [
        ENC_DOMAIN,
        PSI_DOMAIN,
        SCHNORR_DOMAIN,
        ACTION_WITHDRAW,
        ACTION_TRANSFER,
        ACTION_SPLIT,
        ACTION_JOIN,
    ];
    for i in 0..tags.len() {
        for j in (i + 1)..tags.len() {
            assert(tags[i] != tags[j], "domain tags must be pairwise distinct");
        }
    }
}
