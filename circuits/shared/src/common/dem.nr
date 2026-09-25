// Field order k=0..6 and the encrypt-adds / decrypt-subtracts sign MUST match wallets/src/crypto/dem.ts.
use crate::domains::ENC_DOMAIN;
use poseidon::poseidon2::Poseidon2;

pub global DEM_FIELDS: u32 = 7;

pub fn dem_keystream(cek: Field, k: u32) -> Field {
    Poseidon2::hash([cek, ENC_DOMAIN, k as Field], 3)
}

pub fn dem_encrypt(cek: Field, plaintext: [Field; DEM_FIELDS]) -> [Field; DEM_FIELDS] {
    let mut ciphertext: [Field; DEM_FIELDS] = [0; DEM_FIELDS];
    for k in 0..DEM_FIELDS {
        ciphertext[k] = plaintext[k] + dem_keystream(cek, k);
    }
    ciphertext
}

pub fn dem_decrypt(cek: Field, ciphertext: [Field; DEM_FIELDS]) -> [Field; DEM_FIELDS] {
    let mut plaintext: [Field; DEM_FIELDS] = [0; DEM_FIELDS];
    for k in 0..DEM_FIELDS {
        plaintext[k] = ciphertext[k] - dem_keystream(cek, k);
    }
    plaintext
}

#[test]
fn dem_kat_encrypt_decrypt() {
    let cek: Field = 0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bda;
    let plaintext: [Field; DEM_FIELDS] = [
        1,
        0x1234567890123456789012345678901234567890,
        0,
        0,
        100,
        0x2874ae964d8b283e2f521a7f14125fc92747bb9770139b8d4b70ee09e2d83785,
        0,
    ];
    let expected_ct: [Field; DEM_FIELDS] = [
        0x024f79539849d002c0148ca38583eb1d0b61e85739995df0d72d83ca2ca69350,
        0x1f151500c11f2f26d09d61914b53fa46cfc86ca56e12f8ee1a1ccf9f593f2461,
        0x19aef4d2384f4f02d2086e7a4a67bc0d46ae485411ee1250668930d93fd5255b,
        0x1b1b087d9957ceab0fdf063145bc05d5725db0ea2baaf360dea78ca8d9091b83,
        0x2412db8aed74c96d0e99ce8d91e3608b576fdcdee6e47e9388b51c64fb60a082,
        0x0dec6f4f28629a9dffa1a5891978592075ef6419a6d07fd3ff0dfdbc687f3204,
        0x13257c3200ac706a574cf25984a9a77a8eb06790e09281b728df6de05a8a52e0,
    ];

    let ciphertext = dem_encrypt(cek, plaintext);
    for k in 0..DEM_FIELDS {
        assert(ciphertext[k] == expected_ct[k], "DEM ciphertext KAT mismatch");
    }

    let recovered = dem_decrypt(cek, ciphertext);
    for k in 0..DEM_FIELDS {
        assert(recovered[k] == plaintext[k], "DEM roundtrip mismatch");
    }
}

#[test]
fn audit_dem_wrong_cek_garbles() {
    let ct: [Field; DEM_FIELDS] = [
        0x024f79539849d002c0148ca38583eb1d0b61e85739995df0d72d83ca2ca69350,
        0x1f151500c11f2f26d09d61914b53fa46cfc86ca56e12f8ee1a1ccf9f593f2461,
        0x19aef4d2384f4f02d2086e7a4a67bc0d46ae485411ee1250668930d93fd5255b,
        0x1b1b087d9957ceab0fdf063145bc05d5725db0ea2baaf360dea78ca8d9091b83,
        0x2412db8aed74c96d0e99ce8d91e3608b576fdcdee6e47e9388b51c64fb60a082,
        0x0dec6f4f28629a9dffa1a5891978592075ef6419a6d07fd3ff0dfdbc687f3204,
        0x13257c3200ac706a574cf25984a9a77a8eb06790e09281b728df6de05a8a52e0,
    ];
    let cek: Field = 0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bda;
    let garbled = dem_decrypt(cek + 1, ct);
    assert(garbled[0] != 1, "a wrong CEK must not recover the plaintext");
}
