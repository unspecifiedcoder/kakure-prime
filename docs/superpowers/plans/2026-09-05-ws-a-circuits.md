# Workstream A — circuits + Sunspot pipeline — bite-sized plan

Each task: failing test -> run -> implement -> run -> commit.

- [x] 1. Vendor the reference EVM implementation `packages/circuits` at commit `3e7333c` into `circuits/`, trimmed to v1 scope
      (shared, vendor/{ecdh,noir-edwards,poseidon}, standard/{deposit,transfer,withdraw},
      multisig/{transfer,split,join,withdraw}_multisig). `circuits/PROVENANCE.md` records provenance.
      Test: `nargo test --workspace --silence-warnings` green as a parity baseline (PATH must put
      `~/.nargo/bin` (beta.22) ahead of `/usr/local/bin/nargo` (beta.19) — verified as a gotcha).
      Commit: "feat(circuits): vendor the reference EVM implementation circuits at commit 3e7333c".

- [x] 2. Switch tree hash to Poseidon v1. Failing test: update
      `shared/src/lib.nr::test_lean_imt_inclusion_proof` and the `kat_leanimt_tri_parity` test's expected
      root to a value computed under `poseidon::poseidon::bn254::hash_3`; it fails against the current
      Poseidon2 implementation. Implement: `lean_imt_inclusion_proof` calls
      `poseidon::poseidon::bn254::hash_3([left, right, i as Field])` instead of
      `Poseidon2::hash([left, right, i as Field], 3)`. Run: `nargo test --workspace` green, including all
      mutation tests (they exercise `lean_imt_inclusion_proof` only through fixture roots, which get
      regenerated). Commit: "feat(circuits): switch LeanIMT hash to Poseidon v1".

- [x] 3. `circuits/kat/lean_imt_poseidon_v1.json`: depth-32 LeanIMT, genesis case + 8 sequential leaf
      inserts (leaves `1..8`), each entry recording `root` and the leaf's 32 siblings at insertion time.
      Generated two independent ways that must agree byte-for-byte:
        - a Noir test (`shared/src/lib.nr` or a small `kat` crate) that computes roots via
          `lean_imt_inclusion_proof` and prints them (`nargo test --show-output`), used to hand-derive the
          JSON;
        - `circuits/scripts/gen_lean_imt_kat.mjs`, a Node script using `circomlibjs`'s poseidon (which
          implements the same circom-parameter Poseidon as the vendored Noir `poseidon` crate) to compute
          the same tree independently.
      Test: `node circuits/scripts/gen_lean_imt_kat.mjs --check` compares its own computation against the
      committed JSON and against values asserted in a new Noir test. Commit: "test(circuits): add
      Poseidon v1 LeanIMT KAT".

- [x] 4. `justfile` targets under `# --- workstream A` marker: `build-circuits` (per circuit: `nargo compile`
      -> `sunspot compile` -> `sunspot setup` (dev, `INSECURE-DEV`) -> `sunspot deploy` -> artifacts under
      `circuits/target/`), `verify-kat` (`nargo execute` on the KAT witness -> `sunspot prove` -> `sunspot
      verify`). Test: running `just build-circuits` for `transfer_multisig` produces `.json/.ccs/.pk/.vk/.so`
      and exits 0; `just verify-kat` (against `kat_multisig_transfer_accepts`) exits 0. Commit: "build(circuits):
      add build-circuits and verify-kat just targets".

- [x] 5. `circuits/manifest.json` + vitest drift test (`circuits/manifest.test.ts`): per circuit
      `{name, circuit_id, public_input_count, vk_sha256, setup}`. Failing test first (manifest.json absent
      or vk_sha256 wrong) -> implement generation from built `.vk` files -> test recomputes sha256 of each
      `.vk` and the ABI's public input count, compares to manifest. Commit: "feat(circuits): add manifest.json
      and drift test".

- [x] 6. End-to-end prove/verify of `transfer_multisig` using the `kat_multisig_transfer_accepts` fixture
      inputs from `main.nr`, through `nargo execute` -> `sunspot prove` -> `sunspot verify`, using dev
      `.pk`/`.vk` from task 4. Document proof size and `.pw` byte layout (count, field order, endianness) in
      `circuits/README.md`. Also run `sunspot deploy` to produce transfer_multisig's `.so` for the record
      (not committed; gitignored). Commit: "docs(circuits): document proof/public-witness byte layout".

Gitignore large artifacts (`.pk`, `.ccs`, `.so`, `.proof` binaries handled per-file) under `circuits/target/`;
commit `.json` (ACIR), `.vk`, `manifest.json`, KATs, docs.
