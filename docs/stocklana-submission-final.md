# Your equity strategy should not be public alpha

Kakure Prime is confidential treasury and settlement infrastructure for tokenized equities on Solana. Funds, DAOs, and global teams can hold positions under a 3-of-5 policy, settle internally without publishing the plaintext asset, value, recipient, or signer graph, and selectively disclose to an authorized audit quorum.

## Working end to end on public Devnet

Kakure executes a finalized private lifecycle with matching Groth16 verifier programs, not a mock verifier:

1. Deposit into the shielded pool.
2. Settle under a dealerless 3-of-5 FROST quorum.
3. Let the recipient discover and withdraw the exact note.

[Inspect all three transactions, verifier programs, timings, compute units, and privacy boundaries](https://kakure-prime.vercel.app/#/evidence).

The ledger receives commitments, ciphertext, a spent nullifier, and a valid proof. Deposit and withdrawal are honest public boundaries: token accounts and amounts are visible. The internal transfer graph is private. The same 9/9 run rejects a tampered Merkle root, spent-nullifier replay, and an insufficient 2-of-5 quorum.

## Why Solana

Low fees and fast finality make proof-backed distributions practical. Versioned transactions and address lookup tables fit compressed Groth16 proofs, while the native program atomically verifies proofs, spends nullifiers, appends commitments, and moves SPL or Token-2022 assets.

## PreStocks: official-only private-market operations

- The official PreStocks API is the only pre-IPO allowlist; no competing pre-IPO token is integrated.
- Returned contracts are checked on Solana mainnet and must be Token-2022 assets.
- Live token and mark prices enforce a +/-15% mandate before shielding.
- Kakure adds threshold-controlled, selectively auditable private treasury operations for PreStocks.

The public Devnet proof uses a test SPL mint and is not represented as an official PreStocks transaction.

## Pyth: fail-closed settlement risk

- Kakure discovers Pyth's canonical `Crypto.AAPLX/USD` feed.
- A server-only broker keeps the Pyth key out of the browser.
- Price age over 30 seconds or confidence wider than 100 bps blocks execution.
- The current entitlement returns live `Crypto.SOL/USD`, transparently labelled as a cross-market collateral-health gate. Kakure never fabricates an AAPLx price.

## Meteora DBC: traded shielded-equity receipt

- Real Devnet DBC configuration, receipt mint, pool, and finalized buy.
- The price-discovery fee decays from 100 bps to 25 bps over 24 hours.
- Graduation targets DAMM v2 with 10% locked migration liquidity.
- [Inspect the pool](https://explorer.solana.com/address/58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW?cluster=devnet) and [finalized trade](https://explorer.solana.com/tx/57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to?cluster=devnet).

## Implemented

- Seven Noir circuits compiled to Groth16; three matching public Devnet verifiers for the minimum lifecycle
- Native Solana pool with commitment tree, nullifiers, vault accounting, verifier routing, and SPL/Token-2022 validation
- Dealerless FROST DKG and threshold signing
- Threshold compliance encryption with committee-key rotation
- Native and browser/WASM proving, SDK, CLI, indexer, encrypted coordinator, React app, and self-custody Kakure Wallet extension

## Originality disclosure

Kakure Prime transparently builds on **Kakure**, an Apache-2.0 project by the same author that predates Stocklana. The pre-existing foundation includes the base ZK circuits, FROST custody, pool program, SDK, and private-payment flow. Stocklana work adds Token-2022 equity compatibility, xStocks presets, the official-only PreStocks policy rail, the Pyth risk broker, the Meteora DBC receipt/configuration/pool/trade, public Devnet verifier deployment, wallet extension, hosted product, and equity-focused judge experience. Full details are in `STOCKLANA.md`.

## Links

- Product: https://kakure-prime.vercel.app/
- Judge demo: https://kakure-prime.vercel.app/#/demo
- Pitch: https://kakure-prime.vercel.app/pitch-video.html
- Source: https://github.com/unspecifiedcoder/kakure-prime

> Pre-release and unaudited. The Groth16 parameters use an `INSECURE-DEV` setup. Devnet evidence only; never use this deployment with material assets.
