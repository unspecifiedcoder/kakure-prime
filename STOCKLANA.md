# Kakure Prime — Stocklana submission brief

## One line

The confidential prime-brokerage layer for tokenized equities on Solana.

## The problem

Tokenized equities make markets global, programmable, and instant—but public wallets expose the exact portfolio, accumulation strategy, treasury concentration, recipient list, and signer graph of every serious participant. Traditional funds will not move sensitive execution and compensation flows onto a globally readable ledger.

## The product

Kakure Prime turns Token-2022 equities into shielded notes held by a threshold-controlled portfolio. A fund can:

1. Deposit AAPLx, TSLAx, NVDAx, SPYx, or another supported SPL asset.
2. Require a configurable quorum, such as three of five signers, for every movement.
3. Rebalance or distribute positions without publishing amounts, recipients, or the signer set.
4. Give each recipient a private claim link and let them withdraw to their own Solana wallet.
5. Give a compliance committee selective, threshold-based audit access—no unilateral backdoor.

On-chain observers see commitments, nullifiers, and valid Groth16 proofs. Authorized portfolio members see the actual assets and amounts.

## Why it belongs on Solana

- Tokenized equities already exist as composable Token-2022 assets on Solana.
- Fast finality makes private batch settlement practical.
- Programs verify Groth16 proofs on-chain, rather than trusting a hosted privacy service.
- SPL composition lets the same shielded pool support cash and equity assets.

## What is real today

- Seven Noir circuits compiled to Groth16.
- A native Solana pool program with commitment tree, nullifiers, asset vaults, and verifier CPIs.
- Dealerless FROST DKG and threshold signing.
- Threshold compliance encryption with rotatable committee keys.
- SDK, CLI, indexer, encrypted coordinator, local prover, WASM prover, and React application.
- End-to-end local-validator flow: create portfolio → deposit → approve → private transfer → withdraw.
- Token-2022 deposit and withdrawal routing added for Stocklana.
- Live issuer quote data and verified Solana xStock mint presets in the application.
- Live PreStocks catalog, mint addresses, mark prices, and token prices from the official API. The API is the allowlist, and the guided settlement enforces valid contract formatting plus a ±15% token-to-mark mandate.
- Pyth's canonical `Crypto.AAPLX/USD` feed discovery plus a server-side authenticated price broker. The settlement policy rejects prices older than 30 seconds or wider than 100 bps confidence; `PYTH_API_KEY` activates live pricing without exposing the secret to browsers.
- A stock-aware Meteora DBC receipt with fees decaying from 100 bps to the protocol minimum of 25 bps over 24 hours before DAMM v2 graduation. The pool has a finalized devnet buy and observable curve progress.

## Sponsor track scope

- **PreStocks:** official API assets are selectable in the working judge demo. Their contract address and live premium/discount are verified by an official-only policy gate before settlement. No competing pre-IPO token is integrated.
- **Pyth Network:** Kakure discovers the canonical AAPLx feed and uses authenticated price, confidence, and publication time as a settlement risk gate. `apps/web/api/pyth.js` is the secret-safe broker; without `PYTH_API_KEY`, the UI honestly falls back to catalog verification rather than fabricating a price.
- **Meteora DBC:** the product applies a decreasing-fee DBC to a transferable shielded-equity receipt, using a 100 bps early price-discovery fee, a mature 25 bps fee, and DAMM v2 graduation. `scripts/deploy-meteora-dbc.mjs` creates it; `scripts/trade-meteora-dbc.mjs` quotes and executes a buy with the official SDK.

## Devnet deployment

- Kakure pool: `HPzs68TncDWTHocTZv5ekvpMwDjcx4PeHLoTedwBsccF`
- Demo verifier: `37K2Nhpuh2r3xv6gZ9yfA8gPpEpvDXfLkgkK3YmdWVHT`
- Meteora DBC config: `8wqCNyoxQMUGRJwXngG2wxVLzqduTazi2nDjcuoCqbFT`
- Meteora DBC pool: `58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW`
- Shielded-equity receipt mint: `Eqi8f5wf2fDWKriZUGC8qRS9ueYwhf37LDpZupaSbfJ8`
- DBC config transaction: `2f12VxbqsTogybhARtUddxmVdKstxFu67QJHNvqr5QLS97Qcc6FEqofvPsV8cFa7wThUuN2qegDVeRAe6LPbMFkE`
- DBC pool transaction: `4dLKSKqFAwAemaXXwAveqmiWVLiKDdbW8K1pZ8w3beYQSHFasqH2FTgkwSrmxvEqRmbfyFBnhWigF9cADTfmt8mY`
- DBC receipt buy transaction: `57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to`
- Post-trade quote reserve: `0.0198 SOL`; quote-side curve progress: `0.8241%`
- Network: Solana devnet

The verifier above is the repository's explicitly labelled test verifier, used only to exercise the
devnet demonstration path. It is not the production Groth16 verifier and must never custody real assets.

## Demo script (90 seconds)

1. Open Kakure Prime and show live AAPLx, TSLAx, NVDAx, and SPYx prices.
2. Create a “Frontier Equity Fund” portfolio with a 3-of-5 approval policy.
3. Select AAPLx and fund the private portfolio.
4. Show the public/private comparison: the chain gets only a commitment and proof; the quorum sees the position.
5. Paste two private receive addresses, preview the distribution, and collect approvals.
6. Open a recipient claim link and withdraw to a fresh wallet.
7. Open the audit room to show threshold-authorized disclosure.

## Originality disclosure

Kakure Prime builds on Kakure, an Apache-2.0 project by the same author that predates Stocklana. The underlying ZK circuits, FROST custody, pool program, SDK, and private-payroll flow were existing work. The Stocklana-specific work is the Token-2022 compatibility layer, xStocks asset integration, live market experience, private-equities positioning, and demo/submission material. This distinction is intentional and should be included in the submission.

## Safety and limitations

- Pre-release and unaudited; localnet/devnet only.
- Current Groth16 parameters use a development trusted setup.
- Token-2022 base transfers are supported; extension-specific behavior must be audited per asset before production use.
- xStocks availability and use are jurisdiction-dependent. Kakure Prime does not issue securities or provide investment advice.

## Links

- xStocks public metadata and quote API: <https://docs.xstocks.fi/developers>
- Stocklana: <https://hackathons.solana.com/hackathons/stocklana>
