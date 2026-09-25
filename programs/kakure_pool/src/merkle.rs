//! LeanIMT frontier insert, ported from the reference EVM implementation's
//! `MerkleTreeLib.sol::insert`, with the hash swapped for Solana's
//! `sol_poseidon` syscall (BN254, Poseidon v1 / circom parameters) per spec
//! §3.1 / I-5: `node = poseidon_v1([left, right, level])`, big-endian, 3
//! inputs, zero sibling passes through, canonical frontier insert.

use crate::error::PoolError;
use crate::state::{Pool, TREE_DEPTH};
use solana_poseidon::{hashv, Endianness, Parameters};
use solana_program::program_error::ProgramError;

/// `poseidon_v1([left, right, level])`, BN254, big-endian 32-byte inputs and
/// output, matching Noir's `poseidon::bn254::hash_3` and
/// `MerkleTreeLib.sol`'s `Poseidon2.hash_3` call site (hash function
/// swapped to v1 per spec §3.1, argument order unchanged).
pub fn hash3(left: &[u8; 32], right: &[u8; 32], level: u64) -> Result<[u8; 32], ProgramError> {
    let mut level_be = [0u8; 32];
    level_be[24..32].copy_from_slice(&level.to_be_bytes());
    let hash = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right, &level_be])
        .map_err(|_| ProgramError::from(PoolError::InvalidLeaf))?;
    Ok(hash.to_bytes())
}

/// Frontier insert identical to `MerkleTreeLib.sol::insert`: walk levels
/// 0..TREE_DEPTH; even index stores the frontier and stops; odd index hashes
/// `node = H(side_nodes[level], node, level)`. Rejects the zero leaf.
/// Returns `(leaf_index, new_root)`.
pub fn insert(pool: &mut Pool, leaf: &[u8; 32]) -> Result<(u64, [u8; 32]), ProgramError> {
    if *leaf == [0u8; 32] {
        return Err(PoolError::InvalidLeaf.into());
    }
    let leaf_index = pool.next_leaf_index();
    if leaf_index >= (1u64 << TREE_DEPTH) {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut node = *leaf;
    let mut index = leaf_index;

    for level in 0..TREE_DEPTH {
        if index & 1 == 0 {
            pool.set_side_node(level, &node);
            if index == 0 {
                break;
            }
        } else {
            let sibling = pool.side_node(level);
            node = hash3(&sibling, &node, level as u64)?;
        }
        index >>= 1;
    }

    pool.set_next_leaf_index(leaf_index + 1);
    pool.push_root(&node);
    Ok((leaf_index, node))
}

#[cfg(test)]
mod kat_tests {
    use super::*;
    use crate::state::POOL_LEN;

    /// Cross-checks `insert` against workstream A's authoritative LeanIMT
    /// KAT (`circuits/kat/lean_imt_poseidon_v1.json`, produced with
    /// circomlibjs and cross-checked against Noir's `poseidon::bn254::hash_3`).
    /// That repo lives alongside this worktree, not inside it (this
    /// program's owned paths don't include `circuits/`), so the test reads
    /// it by absolute path and is skipped -- not faked -- when unavailable.
    /// Tiny hand-rolled extraction of `"key": "0x...."` / `"key": N` values
    /// in document order -- avoids adding a `serde_json` dev-dependency to
    /// this package (it's resolved together with the real sbf build; see
    /// the toolchain-compatibility notes elsewhere in this file's Cargo.toml).
    fn extract_field_after(text: &str, from: usize, key: &str) -> (String, usize) {
        let key_pat = format!("\"{key}\":");
        let key_rel = text[from..].find(&key_pat).expect("key present");
        let key_start = from + key_rel + key_pat.len();
        let rest = &text[key_start..];
        let value_start = key_start + (rest.len() - rest.trim_start().len());
        let value_area = &text[value_start..];
        if value_area.starts_with('"') {
            let inner = &value_area[1..];
            let end_rel = inner.find('"').expect("closing quote");
            (inner[..end_rel].to_string(), value_start + 1 + end_rel + 1)
        } else {
            let end_rel = value_area.find([',', '\n', '}']).expect("value terminator");
            (value_area[..end_rel].trim().to_string(), value_start + end_rel)
        }
    }

    fn hex_to_field(hex: &str) -> [u8; 32] {
        let hex = hex.trim_start_matches("0x");
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn lean_imt_kat_leaves_1_through_8() {
        // F6 fix: this used to be a machine-specific absolute path
        // (`/mnt/e/github2/kakure/circuits/...`) that only happened to exist
        // on the box this was first written on -- anywhere else (CI
        // included) the file was silently "not found", the test printed
        // SKIP, and `cargo test` still reported `ok`, so the frontier-insert
        // <-> circomlib <-> Noir parity this test exists to guard was
        // unguarded everywhere but that one machine. `CARGO_MANIFEST_DIR` is
        // this crate's own directory (`programs/kakure_pool`); the KAT lives
        // three levels up at `circuits/kat/...` in every checkout of this
        // repo, worktree or not.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../circuits/kat/lean_imt_poseidon_v1.json");
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => panic!("KAT file missing: {path}: {e}"),
        };

        let mut data = vec![0u8; POOL_LEN];
        let mut pool = Pool::new(&mut data).unwrap();

        // Walk each `"case": "leaf_N"` entry in order, skipping the
        // "genesis" (empty-tree) baseline row.
        let mut cursor = 0usize;
        let mut checked = 0;
        loop {
            let case_pat = "\"case\":";
            let Some(rel) = text[cursor..].find(case_pat) else { break };
            let case_pos = cursor + rel;
            let (case, after_case) = extract_field_after(&text, case_pos, "case");
            if case == "genesis" {
                cursor = after_case;
                continue;
            }
            let (leaf_hex, after_leaf) = extract_field_after(&text, after_case, "leaf");
            let (next_idx_str, after_next) = extract_field_after(&text, after_leaf, "next_leaf_index");
            let (root_hex, after_root) = extract_field_after(&text, after_next, "root");

            let leaf = hex_to_field(&leaf_hex);
            let expected_root = hex_to_field(&root_hex);
            let expected_next: u64 = next_idx_str.parse().unwrap();

            let (_, root) = insert(&mut pool, &leaf).expect("insert");
            assert_eq!(root, expected_root, "root mismatch at case {case}");
            assert_eq!(pool.next_leaf_index(), expected_next, "next_leaf_index mismatch at case {case}");

            cursor = after_root;
            checked += 1;
        }
        assert_eq!(checked, 8, "expected 8 leaf-insert KAT entries");
    }
}
