# Kakure Prime — 90-second pitch

## Voice-over

**0–12 seconds — Problem**  
Tokenized equities trade globally on Solana, but every wallet publishes the fund's book: positions, rebalances, recipients, and signer activity. Institutions protect that information everywhere else.

**12–28 seconds — Product**  
Kakure Prime is confidential treasury and settlement for tokenized equities. A fund shields a position into a zero-knowledge note controlled by a three-of-five FROST quorum. No custodian and no shared private key.

**28–48 seconds — PreStocks and Pyth**  
This is not a static mock. The private-market lane loads only official PreStocks assets, verifies every Token-2022 mint on-chain, and enforces a live token-to-mark mandate. For AAPLx, Pyth price, freshness, and confidence form a hard settlement gate—stale or uncertain data blocks execution.

**48–65 seconds — Privacy**  
Authorized signers see the asset and amount. The public chain sees a commitment, a spent nullifier, and a valid Groth16 proof—never the ticker, recipient, amount, or signer graph. A separate auditor quorum can selectively disclose when legitimately required.

**65–78 seconds — Meteora**  
Successful settlement connects to a Meteora DBC equity-receipt market. The real devnet curve starts at a one-percent price-discovery fee, decays to twenty-five basis points, graduates to DAMM v2, and already has a finalized on-chain trade.

**78–90 seconds — Close**  
Kakure Prime gives tokenized equities the missing institutional primitive: private operations, threshold governance, verifiable settlement, and compliant auditability—built natively for Solana.

## Recording shot list

1. Project title and one-line problem.
2. Open `/#/demo`; pause on the three live integration evidence cards.
3. Select Anthropic and point to official mint verification plus NAV policy pass.
4. Switch to AAPLx and show the Pyth freshness/confidence decision.
5. Return to PreStocks and advance through all five settlement stages.
6. Pause on the public-versus-authorized-quorum comparison.
7. Open the finalized Meteora trade link and show devnet confirmation.
8. End on the architecture rail and GitHub URL.

Do not call the guided settlement itself an on-chain transaction. Say that the sponsor data and devnet evidence are live, while the clicks mirror the repository's real local-validator E2E flow.
