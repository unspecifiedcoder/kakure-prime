# Private settlement E2E evidence

Kakure Prime's minimum private settlement path is finalized on public Solana Devnet with three matching Sunspot/Groth16 verifier programs. The full seven-circuit suite is also exercised against a real local validator. Neither path uses the mock verifier or the `dev-verify` feature.

## Public Devnet run

Run date: 2026-09-27 · Result: **9/9 passed**

| Stage | Finalized transaction | Proof / transaction evidence |
|---|---|---|
| Deposit | [`4QSD…c8j4`](https://explorer.solana.com/tx/4QSDN3RSCUm4eSANet9Qd1BSTgkptdFh8EDRBKF7yRs5w1LnJhhyrDUM2WepxbwrLmazr4Pc543FU2hANz1ec8j4?cluster=devnet) | 1.527s proof · 822 bytes · 608,868 CU |
| 3-of-5 private transfer | [`2Eyo…nwsg`](https://explorer.solana.com/tx/2EyosmdTjZ3c7DsgQRBHhGexfEM6JGhGxk1XFJLeAyooPkvuX8yP2iqJjJucC3DeyZqXpeKmgPEvtt13Pqjknwsg?cluster=devnet) | 7.765s proof + submit · 1,125 bytes · 615,921 CU |
| Withdrawal | [`GFua…S7m`](https://explorer.solana.com/tx/GFuaxgsPVUtPQiKbzb12Enoe583t1jCbXuNrFDbgiZQZKtLRKTZS4Dga3cPHq4VSBuJHiUJiqt7EHo8mf2T9S7m?cluster=devnet) | 2.329s proof · 919 bytes · 586,902 CU |

All three signatures were independently re-queried after the run and were `finalized` with no transaction error. The same run also passed stale-root, spent-nullifier replay, and insufficient 2-of-5 quorum rejection.

| Program | Devnet address |
|---|---|
| Kakure pool | [`CTBu…6cBf`](https://explorer.solana.com/address/CTBujgpdNFHAYg9WGDWjgGa68AxYuT1TKQBkRYnv6cBf?cluster=devnet) |
| Deposit Groth16 verifier | [`21sN…XtxM`](https://explorer.solana.com/address/21sN3juRFvjxBokrkB2tNisFpiRnpXTq42XrzbJ3XtxM?cluster=devnet) |
| 3-of-5 transfer Groth16 verifier | [`CNoK…ofwb`](https://explorer.solana.com/address/CNoKnfajTr8XQXs4D84cy89C993KSn4bs5tXZ9Xmofwb?cluster=devnet) |
| Withdrawal Groth16 verifier | [`25pR…PMg4`](https://explorer.solana.com/address/25pR3qcZynCSUxx7atAwahaCih6GeNzEt923YksuPMg4?cluster=devnet) |

The public deployment manifest—including deployment and initialization signatures—is [`deployments/solana-devnet.json`](../../deployments/solana-devnet.json).

## Full local seven-circuit run

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

This is real cryptographic execution, not a UI simulation, but it remains pre-audit software using an `INSECURE-DEV` Groth16 setup. The public Devnet deployment contains the three matching verifier circuits required for deposit, 3-of-5 private transfer, and withdrawal. The four additional circuit programs in the complete suite remain local-only and must not be represented as deployed. Do not use this deployment with material assets.
