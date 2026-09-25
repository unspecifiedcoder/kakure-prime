# Workstream F2 — the real end-to-end localnet scenario: plan + final status

Owner: workstream F2. Scope: `e2e/`, the `justfile` F-marker lines, this file. Landed fixes in
`packages/sdk`, `packages/cli`, `packages/indexer`, `programs/kakure_pool` where a real bug was
found integrating them for real (each with its own test, see the report below).

## 0. Prep
- [x] Read spec §7, master plan interfaces, existing `e2e/{localnet,poolClient,scenario.test,
      smoke.test}.ts` from the prior F pass.
- [x] Confirmed everything (A/B/C/D/E) is merged to `main` (`d4fb144`); `e2e/localnet.ts` still
      pointed at stale sibling-worktree paths from before the merge — fixed.
- [x] Copied the 7 real Sunspot verifier artifacts into `circuits/target/` (only partially
      present).

## 1. Get the harness itself real
- [x] Fix `e2e/localnet.ts`'s stale paths (now `programs/deploy/`, `circuits/target/` in-repo).
- [x] Fix a real indexer-IDL-shape bug: the default `--idl` pointed at a human-readable doc file
      with a different JSON shape than what the indexer's decoder parses. Added
      `e2e/fixtures/kakure_pool.indexer-idl.json`.
- [x] Fix `better-sqlite3`'s native binding (pin `onlyBuiltDependencies`).
- [x] Extend `justfile`'s `build-f-deps` to also build `@kakure/prover`/`@kakure/cli`.
- [x] `just e2e-smoke` green.

## 2. Fill `poolClient.ts`'s `TODO(contract)` seam
- [x] `RealPoolClient` dispatches every `PoolInstructionRequest` to `@kakure/sdk/solana`'s
      `TxBuilder` and sends+confirms. (Ended up using `TxBuilder` + `altHelper.ts`'s `sendV0`
      directly in `scenario.test.ts` for the real steps, since a v0 tx + Address Lookup Table has
      no clean generic `PoolClient`-shaped seam; `RealPoolClient` stands as real, tested
      infrastructure for the simpler non-ALT-dependent callers.)

## 3. Real scenario, step by step (spec §7)
- [x] Step 1 — initialize with the fixture compliance key + all 7 real verifiers + a real
      client-computed genesis leaf. GREEN.
- [x] Step 2 — 5 in-process signers run a real DKG (t=3, n=5) over the real coordinator
      (`@kakure/cli`'s `runDkgCeremony`); derive the canonical group view key. GREEN.
- [x] Step 3 — real deposit proof, multisig-owned note, submitted on-chain. GREEN.
- [x] Step 4 — `MultisigScanEngine` finds the deposited note via the real indexer. GREEN.
- [ ] Step 5 — 3-of-5 propose/sign/execute a real `transfer_multisig` (400_000) to a single-key
      recipient. **BLOCKED** — see "Genuine blocker" below. Real proof against real DKG output IS
      produced; the instruction cannot be submitted in one Solana transaction.
- [ ] Step 6 — recipient withdraw. Depends on step 5; not reachable.
- [ ] Step 7a/7b — StaleRoot / NullifierSpent negative checks against the real `transfer_multisig`
      tx. Depend on step 5; not reachable (their own logic is written and typechecks).
- [x] Step 7c — 2-of-5 signature fails FROST verification. Real, no chain dependency. GREEN.

## Genuine blocker (spec §7 step 5/6, not fixed — reported per the task's own instruction)

`transfer_multisig` (24 public inputs), `split_multisig` (22), and even the single-key `transfer`
(24) **cannot fit in one Solana transaction** under the current wire format
(`programs/kakure_pool/src/instruction.rs`: `proof: Vec<u8>` + `public_inputs: Vec<[u8;32]>` in the
instruction data), no matter how aggressively accounts are moved into an Address Lookup Table.

Measured (see the workstream report for the exact reproduction): a real `transfer_multisig` proof
is 388 bytes; instruction data alone (`tag + vecU8(proof) + vecFixed32(24 inputs)`) is 1165 bytes.
Even with every possible account (including the instruction's own program id and
`ComputeBudget`'s) moved into one shared ALT, leaving only the fee payer as a static key, the
compiled v0 message still exceeds Solana's 1232-byte `PACKET_DATA_SIZE` hard cap — confirmed
directly against `@solana/web3.js`'s `MessageV0.serialize()`, which pre-allocates exactly
`PACKET_DATA_SIZE` bytes and throws `RangeError: encoding overruns Uint8Array` once the real
encoding doesn't fit. `deposit` (13 inputs, 1086 B total), `join_multisig` (14 inputs, 1102 B) fit
comfortably; `withdraw`/`withdraw_multisig` (17 inputs, 1214 B) fit but with only ~18 bytes of
margin — fragile.

This is a real, cross-workstream (A circuit/proof format + B/D wire encoding) architectural
limitation, not something introduced by or fixable within this workstream's scope: closing it
needs either (a) a compressed Groth16 point encoding (would roughly halve the ~388-byte proof, but
requires the Sunspot-built verifier binaries to also accept compressed points — out of reach
without rebuilding those artifacts) or (b) a buffer-account / staged-instruction on-chain protocol
change (a real instruction/account-shape redesign for the four affected circuits). Per the task
brief's own instruction, this is reported precisely rather than worked around with the mock
verifier.

## Bugs found and fixed in other packages (with tests), while integrating for real

1. `packages/sdk/src/merkle/genesis.ts` (`genesisLeaf`): reduced the domain tag mod BN254 but not
   `genesisHash` itself — threw on every real (256-bit) Solana genesis hash. Fixed + regression
   test in `packages/sdk/src/__tests__/solana.test.ts`.
2. `programs/kakure_pool/src/processor.rs` (`initialize`): inserted the genesis leaf via the bare
   `merkle::insert` instead of `insert_and_emit`, so leaf 0 never got a `NoteInserted` event — the
   indexer's tree mirror was off-by-one from the pool's real on-chain leaf numbering for every leaf
   after genesis. Fixed (now emits, ciphertext-less); rebuilt `programs/deploy/kakure_pool.so`
   (same program id).
3. `packages/indexer/src/chain/solanaSource.ts` (`onLogs`): hardcoded `slot: 0` for every
   live-tail event instead of using the real `context.slot` — once a second leaf existed,
   `IndexerStore.getLatestRoot()`'s `ORDER BY slot DESC` could no longer tell which root was
   latest. Fixed + `rowid DESC` tiebreaker in `getLatestRoot()` + regression test in
   `packages/indexer/src/db/store.test.ts`.

## e2e-only fixes (not other packages' bugs, but real and worth recording)

- `e2e/altHelper.ts`: a shared v0 + Address Lookup Table sender, since every real proof-carrying
  instruction is too big for a legacy transaction (see the blocker above for the circuits it still
  isn't enough for).
- `Connection.confirmTransaction`'s websocket-subscription path hangs silently (no thrown error)
  on this harness's validator (pubsub isn't reachable on the port `@solana/web3.js` guesses) —
  every confirmation now uses a bare `getSignatureStatuses` HTTP poll loop instead.
- This validator needs a much larger ALT warmup margin than the spec-minimum 1 slot (empirically
  ~8-10 slots; using 20) — a v0 tx referencing a table extended only 1 slot ago clears preflight
  and then is silently dropped, never included.
- The transfer_multisig memo ephemeral must be resampled until its own public key is even-y
  (`mint::mint_incoming_note`'s assertion) — a memo eph is legitimately random, not derived from a
  rolled index.
