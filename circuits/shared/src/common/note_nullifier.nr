use crate::domains::PSI_DOMAIN;
use poseidon::poseidon2::Poseidon2;

// Leaf blinder + nullifier key, re-derived from CEK, never transmitted.
pub fn psi(cek: Field) -> Field {
    Poseidon2::hash([cek, PSI_DOMAIN], 2)
}

// 2-input arity vs the DEM keystream's 3-input Poseidon2, so the two preimages cannot alias.
pub fn nullifier(note_psi: Field, leaf_index: Field) -> Field {
    Poseidon2::hash([note_psi, leaf_index], 2)
}

// regenerated for kakure.* domains (PSI_DOMAIN moved)
#[test]
fn kat_psi_nullifier() {
    let cek = 0x1fbbfa289c50b7ded032c85e5faa8b3790afc2fd059fd3d299294ff879a08bda;
    let note_psi = psi(cek);
    assert(note_psi == 0x1f33fe53db83297049bd83916d5c35eeff3cdd1a9cbb644c06441cd02d6d55cd);

    let nf = nullifier(note_psi, 3);
    assert(nf == 0x0af38f7cb7dfb742069be7c29bf6ea8ce322842abd873ce47bb6a35319d6231e);

    assert(note_psi != cek);
}
