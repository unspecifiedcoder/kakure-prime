# circuits/ provenance

Vendored verbatim from an internal snapshot of the reference EVM implementation (path
`packages/circuits/`), which is the reference source for Workstream A of the Kakure v1 port (see
`docs/superpowers/plans/2026-09-05-kakure-master-plan.md`, Workstream A, and
`docs/superpowers/specs/2026-09-05-kakure-design.md` §3).

## Copied verbatim (no edits)

- `vendor/` — the three money-path crypto libraries (`ecdh`, `noir-edwards`, `poseidon`), plus
  `vendor/PROVENANCE.md` and `vendor/VENDOR-HASHES.sha256`, which document their own upstream origin. Not
  modified further here.
- `shared/` — every file except `shared/src/lib.nr`, and except the one function noted below.
- `standard/{deposit,transfer,withdraw}/`
- `multisig/{transfer_multisig,split_multisig,join_multisig,withdraw_multisig}/`, including each crate's
  `mutation_tests.nr`.

## Deliberate deviations from the reference EVM implementation (tracked, see kakure design spec §3)

1. **Tree hash: Poseidon2 → Poseidon v1.** `lean_imt_inclusion_proof` in `shared/src/lib.nr` now computes
   `node = poseidon::poseidon::bn254::hash_3([left, right, i as Field])` (the vendored `poseidon` crate's
   own submodule path) instead of `Poseidon2::hash([left, right, i as Field], 3)`. This is the only
   functional edit made anywhere under `circuits/` relative to the reference EVM implementation (item 3 below is a fixture
   regeneration, not a logic change). All
   other Poseidon2 usage (note commitments, `psi`, nullifiers, owner hashes, FROST challenge, DEM/KEM) is
   untouched. KAT vectors in `shared/src/lib.nr`'s tests were regenerated for the new hash; see
   `kat/lean_imt_poseidon_v1.json` for the depth-32 tree KAT shared with the TS/Solana ports.
2. **Workspace trimmed.** Root `Nargo.toml` drops `standard/split`, `standard/join`, `standard/public_claim`,
   and the entire `kage/` swap-adaptor tree (Kage uses Noir recursion, which has no Groth16/Sunspot
   equivalent) — v1 scope per the design doc §1.
3. **`join_multisig`'s FROST KAT fixture regenerated.** `kat_multisig_join_accepts` (and its mutation
   tests) signs `msg_join(root_a, ...)`, and this particular fixture's Merkle path has a non-zero sibling
   (unlike every other v1 circuit's fixture, whose path is all-zero, making `root == leaf` independent of
   the hash function). Switching the tree hash therefore changed `root_a`'s value, invalidating the
   original vendored-snapshot signature. It was regenerated with a throwaway single-signer (t=1) Schnorr witness —
   `z = (k + e*sk) mod SUBGROUP_ORDER` — via a temporary Noir test (not committed), confirmed against
   `verify_frost_spend` before being baked into `kat_gpk()`/`kat_frost_r()`/`KAT_FROST_Z` in
   `multisig/join_multisig/src/main.nr`. See `circuits/README.md` for detail. No circuit logic changed;
   this is a fixture regeneration only, and `join_multisig`'s own tests (60/60) all pass.

## Out of scope for v1 (not copied)

`standard/split`, `standard/join`, `standard/public_claim`, `kage/*` (see design doc §1 "out").

## Not modified

No vendored `.nr` source under `vendor/` is modified. `VENDOR-HASHES.sha256` (copied verbatim from the reference EVM implementation)
remains valid for those files; it does not cover anything under `shared/`, `standard/`, or `multisig/` — those
are Kakure's own circuits, not further-vendored dependencies.
