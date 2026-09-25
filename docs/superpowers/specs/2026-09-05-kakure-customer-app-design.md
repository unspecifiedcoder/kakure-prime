# Kakure Customer App — Design

**Status:** approved 2026-09-05. **Depends on:** v1 core (green e2e at `b9ff5dd`).
**Positioning:** *private payroll & payouts for Solana teams.* The multisig is the engine; payroll is what people buy; the recipient claim link is how it spreads.

## 1. Surfaces

### 1.1 Treasury app (`apps/web`, replaces `apps/dashboard`)
- **Connect** Phantom (wallet-standard). The connected wallet's signature over `"kakure.account.v1"` seeds the `SolanaAccount` (SDK) — no seed phrases shown.
- **Create private treasury**: name, signer wallet addresses (n ≤ 7), threshold t. Runs the SDK DKG in the browser over the coordinator; each signer opens the invite link and participates. Output: group public key + canonical group view key; stored encrypted in the browser (passphrase, scrypt + XChaCha20) and exportable.
- **Fund**: deposit SPL tokens (USDC first) from the connected wallet into the treasury (deposit circuit, multisig-owned note).
- **Pay people** (primary CTA): table or CSV of `address, amount, memo`. Creates ONE proposal = N `transfer_multisig` operations (one per recipient, sequenced against the change note). Signers approve the whole batch with one click (FROST signs N messages in one session). On execution the app proves and submits N transactions, showing per-row progress. Each recipient row gets a claim link.
- **Balances & history**: per-asset balance, spendable vs pending; proposals (pending/approved/executed/failed); decrypted in-browser via the group view key. Never shows leaves, nullifiers, proofs.
- **Settings**: signers, threshold display, export/import encrypted config, indexer/coordinator URLs.

### 1.2 Recipient claim page (`apps/web/claim/:token`)
- Claim link encodes: indexer URL, the recipient's incoming address hint and the leaf index range to scan (no secrets). Recipient connects Phantom → the app derives their `SolanaAccount`, scans, decrypts the note → "You were paid 1,500 USDC privately" → **Withdraw to my wallet** (withdraw circuit) → done. Optional: keep it in the pool ("Keep private") for later.
- Zero install: requires browser proving (§3).

### 1.3 Accountant view (`apps/web/audit`)
- Paste a **scoped view key** (exported from the treasury app: view key + from/to leaf index range). Read-only ledger: date, counterparty (if known), amount, asset, tx signature. CSV export. Never accepts spend keys (tested).

## 2. Architecture
- Vite + React + TypeScript, `@kakure/sdk` in the browser (already Vite-buildable per the dashboard work; keep the `util` shim). State: Zustand; persistence: IndexedDB (encrypted blobs) + `localStorage` for non-secret prefs.
- **ProverPort** abstraction (from SDK `tx/ports.ts`): the app never calls `sunspot` directly. Implementations: `WasmProver` (§3A), `HelperProver` (§3B, treasury side only).
- Coordinator/indexer: existing services; the app talks HTTP/WS per I-7/I-8 (+ `root_cursor`).
- Batch payroll = sequential `transfer_multisig` proposals sharing one FROST signing session; the SDK `tx/plan.ts` picks/chains notes; each tx re-fetches the Merkle witness after the previous confirms.

## 3. Browser proving
- **A (target): gnark → WebAssembly.** Spike: build Sunspot's gnark prover for `GOOS=js GOARCH=wasm`, load `.pk` (~21 MB) + `.ccs`, prove `deposit` and `transfer_multisig` in Chrome; measure time, peak memory, bundle size; witness from `noir_js` (already WASM). Acceptance: transfer_multisig proof < 90 s on a laptop, < 2 GB memory, no server involvement.
- **B (fallback, treasury side only): Kakure Helper.** A small local HTTP service (Node + `sunspot`) on `127.0.0.1` with a per-launch token; the web app posts inputs, gets a `ProofBundle`. Never for recipients.
- Decision rule: recipients require A; if A fails the acceptance bar, recipients get a "claim later on desktop" path and we fix A before launch.

## 4. Security & privacy rules
- Spend keys never leave the browser; encrypted at rest; no telemetry containing addresses/amounts.
- Claim links carry no secrets; a stolen link reveals only that *some* payment exists for *some* address hint.
- Coordinator sees ciphertext only (unchanged). Indexer queries are per-range, not per-note.
- All ixs keep the 1232-byte and 1.4M CU checks (assert in tests).

## 5. Demo flow (hackathon)
Treasury creates a 3-of-5 group → funds 10,000 USDC → pays 5 people in one proposal → 3 signers approve → 5 private transfers execute → one recipient opens their claim link and withdraws → accountant view shows the ledger; explorer shows nothing meaningful. Target: 60–90 s narrated.

## 6. Testing
Component tests (vitest + testing-library) for every surface; a Playwright e2e against localnet (reuse `e2e/localnet.ts`) with the Helper prover; the WASM prover gets its own timing test; "no spend-key input ever renders" tests on claim and audit pages.

## 7. Out of scope (v1 UI)
Mobile, fiat off-ramp, multi-asset batches in one proposal, recurring schedules (v1.1), swaps, mixer-style "shielded exit".
