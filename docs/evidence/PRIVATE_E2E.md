# Private settlement E2E evidence

Kakure Prime's private settlement path is exercised against a real local Solana validator. The test loads the pool and all seven generated Sunspot/Groth16 verifier programs; it does not use the mock verifier or the `dev-verify` feature.

## Verified run

Run date: 2026-09-27

```text
Test Files  1 passed (1)
Tests       9 passed (9)
Duration    130.10s

deposit proof                 3.107s
deposit transaction size     822 bytes
deposit compute              607,641 CU
3-of-5 transfer proof+submit 7.441s
transfer transaction size    1,125 bytes
transfer compute             619,084 CU
withdraw proof               4.625s
withdraw transaction size    919 bytes
withdraw compute             593,371 CU
```

The run proves these behaviors:

1. Initializes the pool with all seven real verifier programs and the compliance key.
2. Runs a dealerless 3-of-5 FROST DKG through the coordinator.
3. Generates and verifies a real deposit proof for an SPL token deposit into the pool vault.
4. Lets the threshold group decrypt and scan its deposited note.
5. Collects exactly three signature shares, generates a real `transfer_multisig` proof, spends the input nullifier, and creates recipient/change commitments.
6. Lets only the recipient scanner discover the 400,000-unit note, generates a real withdrawal proof, and releases exactly 400,000 units from the vault.
7. Rejects a proof against a tampered/unknown Merkle root.
8. Rejects replay of the already-spent nullifier.
9. Rejects an attempted 2-of-5 aggregate signature before settlement.

## Reproduce it

```bash
just build-circuits
just build-programs
just e2e-scenario
```

The executable scenario is [`e2e/scenario.test.ts`](../../e2e/scenario.test.ts). The program enforces verifier routing, Merkle roots, nullifier uniqueness, vault accounting, and withdrawal amounts in [`programs/kakure_pool/src/processor.rs`](../../programs/kakure_pool/src/processor.rs).

## What is and is not public

During the private transfer, the public ledger receives proof material, a spent nullifier, and new commitments/ciphertexts. The plaintext asset, value, recipient, and signer graph are not instruction fields. Authorized holders decrypt their own notes off-chain.

Deposit and withdrawal are boundary operations: their token amount and source/destination token account are visible in those transactions. Kakure hides the internal ownership and transfer graph; it does not claim that a withdrawal destination is invisible inside its own withdrawal transaction.

## Security status

This is real cryptographic execution, not a UI simulation, but it remains pre-audit software using an `INSECURE-DEV` Groth16 setup. Local-validator signatures are intentionally not linked as Devnet Explorer evidence. Public Devnet deployment of the real verifier suite is tracked separately and must not be represented as complete until those program accounts and the full transaction chain are independently visible on Explorer.
