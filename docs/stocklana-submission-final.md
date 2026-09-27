# Your equity strategy should not be public alpha

Kakure Prime is confidential treasury and settlement infrastructure for tokenized equities on Solana. Funds, DAOs, family offices, and global teams can hold positions under a 3-of-5 threshold policy, settle internally without publishing the plaintext asset, value, recipient, or signer graph, and selectively disclose to an authorized audit quorum.

## The working end-to-end product

Kakure Prime now executes the minimum private lifecycle on public Solana Devnet with matching Groth16 verifier programs—not a mock verifier:

1. [Deposit into the shielded pool](https://explorer.solana.com/tx/4QSDN3RSCUm4eSANet9Qd1BSTgkptdFh8EDRBKF7yRs5w1LnJhhyrDUM2WepxbwrLmazr4Pc543FU2hANz1ec8j4?cluster=devnet)
2. [Settle under a dealerless 3-of-5 FROST quorum](https://explorer.solana.com/tx/2EyosmdTjZ3c7DsgQRBHhGexfEM6JGhGxk1XFJLeAyooPkvuX8yP2iqJjJucC3DeyZqXpeKmgPEvtt13Pqjknwsg?cluster=devnet)
3. [Let the recipient discover and withdraw the exact note](https://explorer.solana.com/tx/GFuaxgsPVUtPQiKbzb12Enoe583t1jCbXuNrFDbgiZQZKtLRKTZS4Dga3cPHq4VSBuJHiUJiqt7EHo8mf2T9S7m?cluster=devnet)

The public ledger receives commitments, ciphertext, a spent nullifier, and a valid proof. Deposit and withdrawal remain honest boundary operations: their token accounts and amounts are public. The internal transfer graph is the private part.

The same 9/9 run rejects a tampered Merkle root, replay of a spent nullifier, and a 2-of-5 approval attempt.

## Why Solana

Solana already hosts composable tokenized equities. Low fees and fast finality make proof-backed distributions practical, v0 transactions plus address lookup tables fit compressed Groth16 proofs, and a native program can atomically verify the proof, spend a nullifier, append commitments, and move SPL or Token-2022 assets.

## PreStocks — official-only private-market operations

- The official PreStocks API is the only pre-IPO asset allowlist; no competing pre-IPO token is integrated.
- Returned contracts are checked on Solana mainnet and must be Token-2022 assets.
- Live token and mark prices enforce a ±15% mandate before shielding.
- Kakure adds a new use case for PreStocks: threshold-controlled, selectively auditable private treasury operations.

The public Devnet proof run uses a test SPL mint; it is not represented as an official PreStocks transaction.

## Pyth — fail-closed settlement risk

- Kakure discovers Pyth's canonical `Crypto.AAPLX/USD` feed.
- A server-only broker keeps the Pyth key out of the browser.
- Freshness and confidence are hard gates: older than 30 seconds or wider than 100 bps blocks execution.
- The current entitlement returns live `Crypto.SOL/USD`, which is transparently labelled as a cross-market collateral-health gate. Kakure never fabricates an AAPLx price.

## Meteora DBC — traded shielded-equity receipt

- Real Devnet DBC configuration, mint, pool, and finalized buy.
- Price-discovery fee decays from 100 bps to the 25 bps protocol minimum over 24 hours.
- Graduation targets DAMM v2 with 10% locked migration liquidity.
- [Inspect the pool](https://explorer.solana.com/address/58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW?cluster=devnet) and [finalized trade](https://explorer.solana.com/tx/57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to?cluster=devnet).

## What is implemented

- Seven Noir circuits compiled to Groth16; three matching public Devnet verifier programs for the minimum lifecycle
- Native Solana pool with commitment tree, nullifiers, vault accounting, verifier routing, SPL and Token-2022 validation
- Dealerless FROST DKG and threshold signing
- Threshold compliance encryption with committee-key rotation
- Native and browser/WASM proving, SDK, CLI, indexer, encrypted coordinator, React product and self-custody Kakure Wallet extension

## Originality disclosure

Kakure Prime transparently builds on **Kakure**, an Apache-2.0 project by the same author that predates Stocklana. The pre-existing foundation includes the base ZK circuits, FROST custody, pool program, SDK, and private-payment flow. Stocklana work adds Token-2022 equity compatibility, xStocks presets, the official-only PreStocks policy rail, the Pyth settlement-risk broker, the Meteora DBC receipt/configuration/pool/trade, public Devnet verifier deployment, wallet extension, hosted product, and equity-focused judge experience. The full disclosure is in `STOCKLANA.md`.

## Links

- Live product: https://kakure-prime.vercel.app/
- 60-second judge path: https://kakure-prime.vercel.app/#/demo
- Pitch: https://kakure-prime.vercel.app/pitch-video.html
- Technical evidence: https://github.com/unspecifiedcoder/kakure-prime/blob/main/docs/evidence/PRIVATE_E2E.md
- Source: https://github.com/unspecifiedcoder/kakure-prime

> Pre-release and unaudited. The current Groth16 parameters use an `INSECURE-DEV` setup. Devnet evidence only; never use this deployment with material assets.
