# Kakure v1 Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working shielded FROST-multisig treasury on Solana localnet: DKG → deposit → 3-of-5 private transfer → recipient withdraw, all proof-gated.

**Architecture:** Noir circuits (vendored from the reference EVM implementation) compiled to Groth16 with Sunspot; one Anchor program `kakure_pool` (LeanIMT commitment tree, nullifier PDAs, SPL vaults, compliance key) that CPIs into Sunspot-generated verifier programs; a TypeScript SDK ported from the reference EVM implementation's `wallets` package plus prover, indexer, coordinator, CLI and dashboard.

**Tech Stack:** Noir 1.0.0-beta.22, Sunspot (`/usr/local/bin/sunspot`, verifier crate at `/root/sunspot/gnark-solana/crates/verifier-bin`), Go 1.24 (`/usr/local/go/bin`), Anchor (latest via `avm`), Agave/solana-cli 3.0, Rust 1.95, Node 22, pnpm 10, TypeScript, vitest, `@noir-lang/noir_js`, `@solana/web3.js` v1 + `@coral-xyz/anchor`, `litesvm`.

**Spec:** `docs/superpowers/specs/2026-09-05-kakure-design.md` — read it first; this plan argues from it.

**Source of truth for the port:** `an internal reference-EVM-implementation checkout` (read-only reference; commit `3e7333c`). Copy, do not symlink.

## Global Constraints

- Noir pin `1.0.0-beta.22` everywhere (`nargo --version` must print it; `~/.nargo/bin/nargo`).
- Tree hash is Poseidon **v1** (circom parameters, `poseidon::bn254::hash_3`); every other hash stays Poseidon2. (spec §3.1)
- `asset_id = sha256("kakure.asset.v1" ‖ mint)[0..20]` big-endian as a Field. (spec §3.2)
- `recipient_field = sha256("kakure.recipient.v1" ‖ destination_token_account)` with byte 0 set to `0x00`. (spec §3.3)
- `intent_hash` must be `0`. (spec §3.4)
- Root ring buffer size `256`; `TREE_DEPTH = 32`; leaf `0` rejected. (spec §3.6, §4)
- Every package: TypeScript strict, vitest, `pnpm test` green, no `any` in exported types.
- Commit after every task with a conventional-commit message; never commit `.pk`, `.ccs`, `.so` (gitignored).
- No secrets, no hosted proving, coordinator never logs `(session_id, timestamp)` together.

---

## Frozen interfaces (all workstreams code against these; changing one requires editing this file first)

### I-1. Circuit IDs and public-input layouts (flat `Field[]`, in order)

| CircuitId | name | count | layout |
|---|---|---|---|
| 0 | `deposit` | 13 | `[cpk_x, cpk_y, leaf, eph_pub_x, value, asset_id, ct0..ct6]` |
| 1 | `transfer` | 24 | `[cpk_x, cpk_y, nullifier, root, memo_leaf, memo_eph_x, memo_tag, memo_cek_wrap, memo_ct0..6, change_leaf, change_eph_x, change_ct0..6]` |
| 2 | `withdraw` | 17 | `[withdraw_value, recipient, intent_hash, cpk_x, cpk_y, nullifier, root, asset_id, change_leaf, change_eph_x, change_ct0..6]` |
| 3 | `transfer_multisig` | 24 | same as `transfer` |
| 4 | `split_multisig` | 22 | `[cpk_x, cpk_y, nullifier, root, out1_leaf, out1_eph_x, out1_ct0..6, out2_leaf, out2_eph_x, out2_ct0..6]` |
| 5 | `join_multisig` | 14 | `[cpk_x, cpk_y, nullifier_a, nullifier_b, root, out_leaf, out_eph_x, out_ct0..6]` |
| 6 | `withdraw_multisig` | 17 | same as `withdraw` |

Field encoding on the wire: 32-byte big-endian, canonical (< BN254 scalar modulus). Sunspot's `.pw` public-witness file is the source; the prover converts it to this array.

### I-2. `kakure_pool` accounts and seeds

- `Pool` PDA seeds `[b"pool"]`. Fields (Anchor/borsh, in order): `authority: Pubkey`, `paused: bool`, `compliance_version: u32`, `compliance_pk_x: [u8;32]`, `compliance_pk_y: [u8;32]`, `verifiers: [Pubkey; 7]`, `next_leaf_index: u64`, `side_nodes: [[u8;32];32]`, `root_cursor: u8`, `roots: [[u8;32];256]`. Use `zero_copy` (account is ~9.4 KB).
- `Asset` PDA seeds `[b"asset", asset_id: [u8;20]]`: `mint: Pubkey`, `vault: Pubkey`, `asset_id: [u8;20]`, `bump: u8`. Vault = associated token account of the `Pool` PDA for `mint`.
- `Nullifier` PDA seeds `[b"nullifier", nullifier: [u8;32]]`: `bump: u8` only.
- Verifier programs: called by CPI with instruction data `proof_bytes ‖ public_witness_bytes` exactly as `sunspot deploy`'s `verifier-bin` expects (see `/root/sunspot/gnark-solana/crates/verifier-bin/src/lib.rs`).

### I-3. Instructions (Anchor names, args)

```
initialize(compliance_pk_x: [u8;32], compliance_pk_y: [u8;32], verifiers: [Pubkey;7])
set_verifier(circuit_id: u8, program: Pubkey)
rotate_compliance_key(x: [u8;32], y: [u8;32])
set_paused(paused: bool)
deposit(proof: Vec<u8>, public_inputs: Vec<[u8;32]>, amount: u64)
transfer(proof, public_inputs)              // circuit 1
transfer_multisig(proof, public_inputs)     // circuit 3
split_multisig(proof, public_inputs)        // circuit 4
join_multisig(proof, public_inputs)         // circuit 5
withdraw(proof, public_inputs, amount: u64)            // circuit 2
withdraw_multisig(proof, public_inputs, amount: u64)   // circuit 6
```

Errors (exact names): `Paused, InvalidPublicInputCount, ComplianceKeyStale, StaleRoot, NullifierSpent, InvalidProof, InvalidLeaf, AmountMismatch, AssetMismatch, AssetCollision, RecipientMismatch, IntentHashNotZero, UnsupportedMint, VerifierUnset`.

### I-4. Events (Anchor `emit_cpi!`)

```
NoteInserted { leaf_index: u64, leaf: [u8;32], eph_pub_x: [u8;32], tag: Option<[u8;32]>, cek_wrap: Option<[u8;32]>, ciphertext: [[u8;32];7], root: [u8;32] }
NullifierSpent { nullifier: [u8;32] }
ComplianceKeyRotated { old_version: u32, new_version: u32, x: [u8;32], y: [u8;32] }
```

`tag`/`cek_wrap` are `Some` only for transfer memo notes.

### I-5. Tree

LeanIMT, depth 32, `node = poseidon_v1([left, right, level])` (Solana `sol_poseidon`, BN254, big-endian inputs), zero sibling passes through, frontier insert as in the reference EVM implementation `MerkleTreeLib.sol`. Genesis leaf = `poseidon2([GENESIS_DOMAIN, cluster_genesis_hash_as_field])` where `GENESIS_DOMAIN` is copied from `the reference EVM implementation's wallets package/src/merkle/genesis.ts`; inserted by `initialize`. Shared KAT file: `circuits/kat/lean_imt_poseidon_v1.json` (produced by workstream A, consumed by B and C).

### I-6. Prover output (workstream D produces, E/F consume)

```ts
export interface ProofBundle { circuitId: CircuitId; proof: Uint8Array; publicInputs: Uint8Array[] /* 7..24 × 32 bytes BE */; }
export function prove(circuitId: CircuitId, inputs: Record<string, unknown>): Promise<ProofBundle>;
```

### I-7. Coordinator envelope (E produces, D/F consume)

```ts
interface Envelope { session_id: string /* hex32 */; seq: number; kind: "dkg1"|"dkg2"|"proposal"|"nonce"|"share"|"final"; ciphertext: string /* base64 */; }
```
HTTP `POST /sessions/:id/messages` (append), `GET /sessions/:id/messages?since=seq` (long-poll), WS `/sessions/:id` (push). Server stores ciphertext only; TTL 24h.

### I-8. Indexer API (E produces, C/D/F consume)

`GET /root` → `{root, next_leaf_index, roots: string[256]}`; `GET /path/:leaf_index` → `{siblings: string[32]}`; `GET /notes?from=<leaf_index>` → `NoteInserted[]`; `GET /nullifiers/:hex` → `{spent: bool}`; `GET /compliance` → `[{version, x, y, from_slot}]`.

### I-9. Repo layout and package names

`circuits/` (Noir workspace), `programs/kakure_pool/`, `packages/sdk` (`@kakure/sdk`), `packages/prover` (`@kakure/prover`), `packages/indexer` (`@kakure/indexer`), `packages/coordinator` (`@kakure/coordinator`), `packages/cli` (`@kakure/cli`), `apps/dashboard` (`@kakure/dashboard`), `e2e/`. Root: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `justfile`, `Anchor.toml`.

---

## Workstreams

Each workstream lead: (1) read the spec and this file, (2) write `docs/superpowers/plans/2026-09-05-ws-<letter>-<name>.md` in the bite-sized task format (failing test → run → implement → run → commit), (3) execute it, (4) report: what shipped, test output, deviations from the frozen interfaces (must be none — flag instead).

### Workstream A — circuits + Sunspot pipeline (`circuits/`)

1. Copy from the reference EVM implementation `packages/circuits`: `shared/`, `vendor/` (all three + PROVENANCE + hashes), `standard/{deposit,transfer,withdraw}`, `multisig/{transfer,split,join,withdraw}_multisig`, root `Nargo.toml` trimmed to those members. Add `circuits/PROVENANCE.md` (the reference EVM implementation's commit `3e7333c`).
2. Switch `lean_imt_inclusion_proof` in `shared/src/lib.nr` to `poseidon::bn254::hash_3([left, right, i as Field])`; update its unit test vectors; `nargo test --workspace` green (including mutation tests).
3. `circuits/kat/lean_imt_poseidon_v1.json`: 8 leaves inserted sequentially, expected roots after each insert, and sibling paths; generated by a Noir test that prints, or by a small TS script using `circomlibjs`'s poseidon — both must agree.
4. `justfile` targets: `build-circuits` (nargo compile all 7 → `sunspot compile` → `sunspot setup` (dev) → `sunspot deploy` → `circuits/target/<name>.{json,ccs,pk,vk,so}`), `verify-kat` (nargo execute KAT witness → `sunspot prove` → `sunspot verify`). `GNARK_VERIFIER_BIN=/root/sunspot/gnark-solana/crates/verifier-bin`.
5. `circuits/manifest.json`: per circuit `{name, circuit_id, public_input_count, vk_sha256, setup: "INSECURE-DEV"}`; a vitest drift test that recomputes and compares.
6. Prove-and-verify the `transfer_multisig` KAT witness (`kat_multisig_transfer_accepts` inputs from `main.nr`) through Sunspot end to end; record proof size and public-witness byte layout in `circuits/README.md` — this confirms I-1 byte encoding for D.

### Workstream B — pool program (`programs/kakure_pool/`)

Anchor workspace at repo root (`anchor init` style, program named `kakure_pool`). If the installed Anchor cannot build against the Agave 3.0 toolchain, use a native `solana-program` 2.x/3.x crate with the same account/instruction/event contract and document why.

1. `Pool` zero-copy account + `initialize` + genesis leaf insert; `LeanIMT` module (frontier insert with `sol_poseidon`, root ring) tested against `circuits/kat/lean_imt_poseidon_v1.json` (if A hasn't produced it yet, generate the same vectors with the `light-poseidon` crate and reconcile later).
2. Admin ixs + errors + events (I-3, I-4).
3. `verify_cpi(circuit_id, proof, public_inputs)` helper: builds `proof ‖ public_witness` per `verifier-bin` format, invokes `pool.verifiers[circuit_id]`, maps failure to `InvalidProof`. For tests, a `mock_verifier` program in `programs/mock_verifier/` that accepts iff the first proof byte is `0x01`.
4. `deposit` (asset registry, `transfer_checked` into vault, reject Token-2022 mints with extensions), then `transfer`/`transfer_multisig`, `split_multisig`, `join_multisig`, `withdraw`/`withdraw_multisig` — each with litesvm tests for every error in I-3.
5. Export IDL to `target/idl/kakure_pool.json` and TS types; commit a copy at `packages/sdk/src/solana/idl/kakure_pool.json` (C depends on it — publish early with the final account/ix shapes even before all ixs are implemented).

### Workstream C — SDK port (`packages/sdk/`)

1. Copy chain-agnostic modules from `the reference EVM implementation's wallets package/src` (`frost/`, `tss/`, `threshold/`, `note/`, `merkle/LeanIMT.ts`, `discovery/`, `tx/plan.ts`, `tx/assemble.ts`, `crypto/` minus EVM bits) with their tests; make tests green with the same dependencies (`@aztec/foundation`, `@zk-kit/baby-jubjub`, poseidon libs).
2. Replace `merkle/LeanIMT.ts` hash with Poseidon v1 (circom params) and verify against `circuits/kat/lean_imt_poseidon_v1.json`.
3. New `solana/` module: `assetId(mint: PublicKey): Uint8Array(20)`, `recipientField(dest: PublicKey): Uint8Array(32)`, `genesisLeaf(genesisHash)`, PDA derivations (I-2), `ChainView` implementation over the indexer API (I-8), `TxBuilder` producing the ixs in I-3 (with `ComputeBudget` 1.4M CU) from a `ProofBundle` (I-6).
4. Replace `keys/DarkAccount.ts` with a Solana-keyed account (seed from an ed25519 keypair signature over `"kakure.account.v1"`), keep the derived key hierarchy identical.
5. `sync/ScanEngine.ts` port: consumes `NoteInserted` events from the indexer, trial-decrypts with view/group keys (uses `frost/multisigScan.ts`), maintains balances and spendable notes.

### Workstream D — prover + CLI (`packages/prover/`, `packages/cli/`)

1. Prover: `InputMap` marshalling copied from `the reference EVM implementation/packages/prover/src/marshal.ts` and `provers/*`; witness via `noir_js`; write `witness.gz`; run `sunspot prove`; parse `.proof`/`.pw` into `ProofBundle` (I-6); self-verify with `sunspot verify`. Tests use A's `circuits/target/*.json|ccs|pk` and the KAT inputs; if artifacts are absent, tests are skipped with a clear message, never faked.
2. CLI (`kakure`): `keygen`, `group create --threshold 3 --members 5` / `group join` (DKG over the coordinator, I-7), `deposit --mint --amount`, `balance`, `propose transfer|split|join|withdraw`, `sign <proposal>`, `execute <proposal>` (aggregates shares → prove → send). Config in `~/.kakure/config.json`, keys encrypted at rest with a passphrase (scrypt + xchacha20-poly1305).

### Workstream E — indexer + coordinator (`packages/indexer/`, `packages/coordinator/`)

1. Indexer: subscribe to `kakure_pool` transactions (websocket `logsSubscribe` + `getSignaturesForAddress` backfill), decode `emit_cpi!` events with the IDL, maintain a LeanIMT mirror (reuse `@kakure/sdk` LeanIMT), SQLite store, serve I-8. Tests with recorded fixtures.
2. Coordinator: I-7 over Fastify + ws; in-memory + SQLite; TTL; privacy-log test asserting no log line contains both a session id and a timestamp.

### Workstream F — e2e + dashboard (`e2e/`, `apps/dashboard/`)

1. `e2e/localnet.ts`: start `solana-test-validator` with `kakure_pool`, `mock_verifier` (until A's `.so` exist) then real verifiers; spin up indexer + coordinator; run the spec §7 scenario with 5 in-process signers; assert balances, nullifier rejection, stale-root rejection.
2. Dashboard (Vite + React, read-only): paste/import a view key, fetch notes from indexer, decrypt in-browser, show balances and history; never asks for spend keys.

## Integration order

A and B and C and E start immediately (no blockers). D starts when A publishes `circuits/target` for at least `deposit` and `transfer_multisig` and C publishes `solana/` types. F starts when B's IDL and E's APIs exist; runs with the mock verifier first, then real verifiers.

## Self-review (done at write time)

- Spec coverage: §1 scope → A/B/C/D/E/F; §2 stack → A, D; §3 crypto changes → A (3.1, 3.5), B+C (3.2, 3.3, 3.4, 3.6); §4 program → B; §5 components → C/D/E/F; §6 security → A (manifest), B (tests), E (log test); §7 testing → each workstream + F.
- Type consistency: `CircuitId` numbering in I-1 is used by I-3 comments, I-6, and A's manifest; `ProofBundle` in I-6 is consumed by C's `TxBuilder` and D; `Envelope` in I-7 by D's CLI and E.
