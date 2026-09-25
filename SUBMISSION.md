# Kakure Prime

**The confidential prime-brokerage layer for tokenized equities on Solana.**

Public wallets expose a fund's positions, rebalances, recipients, and signer graph. Kakure Prime lets funds, DAOs, family offices, and companies custody and distribute tokenized equities under threshold approval while Solana sees only commitments, nullifiers, and valid zero-knowledge proofs.

## The 60-second experience

Open the [guided judge demo](https://kakure-prime.vercel.app/#/demo). Choose an official PreStocks asset, pass its live NAV policy, shield the position, collect a 3-of-5 FROST quorum, generate the settlement proof, and see exactly what the public chain can—and cannot—learn.

The guided clicks are simulated for accessibility. The repository separately contains the real circuits, Solana programs, SDK, prover, FROST ceremonies, encrypted coordinator, indexer, and local-validator end-to-end flow.

## Sponsor integrations that do real work

### PreStocks — official-only private-market settlement

- The official PreStocks API is the asset allowlist; no competing pre-IPO token is integrated.
- Every returned mint is checked on Solana mainnet and must be owned by Token-2022.
- Live token price and mark price feed a ±15% mandate. Assets outside the mandate are blocked before shielding.
- Judges can inspect the selected official mint directly from the demo.

### Pyth — market-risk enforcement, not decoration

- Kakure discovers the canonical `Crypto.AAPLX/USD` feed.
- The authenticated server broker retrieves price, confidence, and publication time without exposing the key to the browser.
- Kakure discovers `Crypto.AAPLX/USD`; because the free trial does not entitle that feed, production transparently uses live `Crypto.SOL/USD` as a cross-market collateral-health gate.
- Equity settlement is blocked when the active price is older than 30 seconds or confidence exceeds 100 bps.
- The judge UI exposes the active symbol, decision, and feed ID—never a fabricated AAPLx price.

### Meteora DBC — a traded shielded-equity receipt

- Official Meteora SDK config: 100 bps price-discovery fee decaying to the 25 bps protocol minimum over 24 hours.
- Graduation target: Meteora DAMM v2, with 10% permanently locked migration liquidity.
- A real devnet config, receipt mint, pool, and finalized buy exist—not a mock card.
- [Pool](https://explorer.solana.com/address/58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW?cluster=devnet) · [Finalized trade](https://explorer.solana.com/tx/57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to?cluster=devnet)

## Why Solana

Tokenized equities already live as composable Token-2022 assets. Solana's low fees and fast finality make private batch settlement practical, while native programs can verify Groth16 proofs and move the underlying asset atomically.

## What works

- Seven Noir circuits compiled to Groth16
- Native Solana shielded pool with vaults, nullifiers, commitment tree, and verifier CPIs
- Dealerless FROST DKG and threshold signing
- Threshold compliance encryption with rotatable committee keys
- Token-2022 deposit and withdrawal routing
- SDK, CLI, indexer, coordinator, local/WASM prover, React application
- Local-validator E2E: create → deposit → approve → transfer → claim → withdraw
- Deployed devnet programs and verifiable Meteora lifecycle evidence

## Originality disclosure

Kakure Prime transparently builds on Kakure, an Apache-2.0 project by the same author that predates Stocklana. The pre-existing work includes the base ZK circuits, FROST custody, pool program, SDK, and private-payment flow. Stocklana work adds Token-2022 equity compatibility, xStocks support, the official-only PreStocks policy rail, Pyth settlement-risk gate and secret-safe broker, Meteora DBC receipt/config/pool/trade, hosted equity experience, and submission evidence.

## Safety

Pre-release, unaudited, and devnet/localnet only. The current trusted setup and demo verifier are not production-safe. Kakure Prime does not issue securities or provide investment advice.

- **Demo:** https://kakure-prime.vercel.app/#/demo
- **Pitch video:** https://kakure-prime.vercel.app/pitch-video.html
- **Technical video:** https://kakure-prime.vercel.app/demo-video.html
- **Source:** https://github.com/unspecifiedcoder/kakure-prime
