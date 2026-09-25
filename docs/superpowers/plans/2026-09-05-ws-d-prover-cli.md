# Workstream D — prover + CLI, bite-sized plan

Each task: write a failing test, run it (see it fail for the right reason), implement, run
(green), commit. No placeholders / no faked proofs.

## packages/prover (`@kakure/prover`)

1. Scaffold package (`package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `src/index.ts`
   stub, vitest config). Failing test: `src/config.test.ts` asserts `resolveArtifactsDir()`
   defaults to `circuits/target` and honours `KAKURE_ARTIFACTS_DIR` / an explicit option.
2. `src/marshal.ts`: port `pointHex`, `marshalNote`, `memoRecipientPoints`,`marshalU128` from
   the reference EVM implementation (adapted: `Fr`/`Point` from `@kakure/sdk`'s re-exports, no EVM-only bits). Failing
   test: unit tests for each helper (range checks, mismatch errors).
3. `src/witness.ts`: `buildWitness(circuitJson, inputMap) -> Uint8Array` via
   `new Noir(circuitJson).execute(inputMap)`, gzip via node `zlib`, matching Sunspot's expected
   `witness.gz`. Failing test: execute the shipped `transfer_multisig.json` ACIR against the KAT
   `InputMap` (skip with a clear message if `circuits/target/transfer_multisig.json` is absent).
4. `src/artifacts.ts`: locate `<dir>/<circuit>.{json,ccs,pk,vk}`; `hasArtifacts(circuit)`.
5. `src/sunspot.ts`: `proveWithSunspot(paths, witnessPath) -> {proofPath, pwPath}` (spawns
   `sunspot prove`), `verifyWithSunspot(vk, proof, pw) -> boolean` (spawns `sunspot verify`).
   Failing test: round-trip against the pre-built `transfer_multisig` artifacts (skip if binary or
   artifacts missing).
6. `src/decode.ts`: `decodePublicWitness(pwBytes) -> Uint8Array[]` (12-byte header + 32-byte BE
   chunks, I-1 order) and `decodeProof(proofBytes)` structural fields (A/B/C/commitments/pok) plus
   `proofBytesForChain(bundle)`. Failing test: parse the committed `.pw`/`.proof` fixtures and
   check exact byte offsets/sizes/values (compliance key at [0..1], `root` at [3] for
   `transfer_multisig`).
7. `src/circuits/transferMultisig.ts` (+ `deposit.ts`, `withdraw.ts`, `splitMultisig.ts`,
   `joinMultisig.ts`, `transfer.ts`, `withdrawMultisig.ts`): per-circuit `InputMap` builders keyed
   by the Noir parameter names in each `main.nr`.
8. `src/prove.ts`: `prove(circuitId, inputs, opts?) -> ProofBundle` wiring 1-7 + self-verify via
   `sunspot verify` before returning; implements `ProverPort`. Failing test: capability probe
   (`environment: "native"`, circuits = whichever have artifacts on disk).
9. End-to-end test `src/__tests__/transferMultisig.e2e.test.ts`: prove the
   `kat_multisig_transfer_accepts` KAT for real, assert `publicInputs.length === 24`,
   `publicInputs[0..1]` equal the compliance key fixture, `publicInputs[3]` equals the root the
   circuit computed, self-verify passes, record proof/pw sizes. Skips with a clear message if
   `circuits/target/transfer_multisig.{json,ccs,pk,vk}` are absent.
10. `justfile`: `test-prover` under the workstream D marker.

## packages/cli (`@kakure/cli`)

11. Scaffold (`package.json` with `bin: {kakure: ./dist/cli.js}`, commander, tsconfig). Failing
    test: `kakure --help` (via commander's parse, no subprocess) lists all commands.
12. `src/config.ts`: `~/.kakure/config.json` load/save (network, coordinator/indexer URLs, program
    id). Failing test: round-trip in a temp dir.
13. `src/keystore.ts`: encrypted keystore — scrypt (N=2^15) KDF + XChaCha20-Poly1305
    (`@noble/ciphers`) over the Solana `Keypair` secret bytes. Failing test: encrypt/decrypt
    round-trip, wrong-passphrase rejection, file permissions (0600).
14. `kakure keygen`: generates an ed25519 `Keypair`, writes the encrypted keystore, prints the
    pubkey. Test via the exported command handler (no subprocess).
15. In-memory fake coordinator + fake indexer HTTP servers for CLI tests (implement the exact I-7 /
    I-8 contracts on ephemeral ports) — `src/__tests__/fakes/`.
16. `src/dkg.ts`: run the Feldman DKG (`@kakure/sdk`'s `tss/dkg.ts` + `groupViewKey.ts`) over the
    coordinator: each round's payload is XChaCha20-Poly1305-sealed to every other member using a
    static X25519 ECDH per member (member's ed25519 identity converted to X25519 via
    `@noble/curves/ed25519`'s `edwardsToMontgomeryPub/Priv`), one ciphertext per recipient packed
    into one `Envelope`; `kakure group create --threshold --members`, `kakure group join
    <session>`. Test against the fakes: two simulated members reach the same `gpk`/threshold
    shares.
17. `src/proposal.ts` + `kakure propose transfer|split|join|withdraw`, `kakure sign <proposal>`,
    `kakure execute <proposal>`: proposal state machine (draft -> collecting signatures -> ready ->
    executed), persisted as coordinator `proposal` envelopes; `sign` runs FROST round 1+2 via
    `@kakure/sdk`'s `frost/*`; `execute` aggregates shares, calls `@kakure/prover`'s `prove`,
    builds the ix via `TxBuilder`, and (if `--dry-run` is not set) sends via `@solana/web3.js`.
    Test the state machine end-to-end against fakes and a fake `ProverPort`/`ChainView`, no
    validator required.
18. `kakure deposit --mint --amount`, `kakure balance` (wraps `ScanEngine` over the fake indexer).
19. `justfile`: `test-cli` under the workstream D marker; `test-ws-d` runs both.

Commit after every green step. Run vitest with `--pool=forks --poolOptions.forks.maxForks=2`.
