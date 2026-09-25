# @kakure/web

Private payroll and payouts for Solana teams. See
`docs/superpowers/specs/2026-09-05-kakure-customer-app-design.md` for the product design and
`docs/superpowers/plans/2026-09-05-ws-i-webapp.md` for the implementation plan.

## Routes

- `/` — connect a wallet, create or join a private treasury.
- `/treasury/:id` — unlock (passphrase) a treasury on this device, then Fund / Pay people /
  Balances / Settings.
- `/claim/:token` — a recipient's claim link. No install required to check the amount; withdrawing
  needs browser proving (see "Proving" below).
- `/audit` — paste a scoped view key (personal or treasury) for a read-only ledger + CSV export.
  Never accepts a spend key.

## Proving

Two `ProverPort` implementations, routed by circuit (`src/prover/router.ts`):

- **Kakure Helper** (`packages/helper`): a small local HTTP service wrapping the native prover.
  Used for `transfer_multisig` (the treasury "Pay people" batch) — proving that circuit in-browser
  is currently too slow (see `packages/prover-wasm`'s spike results on branch `ws/j-wasm-prover`).
- **WasmProver** (`src/prover/wasmProver.ts`): a stub today — throws `NotImplementedError`. Once
  `@kakure/prover-wasm` lands on `main`, wire it in at `src/prover/router.ts`'s `wasmRoute()`. Used
  for `deposit` and `withdraw` (personal deposits and the recipient claim page) — these must never
  require the Helper, so the claim page works with zero install.

## Running the full stack locally

Everything binds to `127.0.0.1`. Build the workspace's server packages once, then run each of these
in its own terminal (order matters only for the localnet steps):

```sh
# 1. From the repo root: build everything web depends on.
pnpm --filter @kakure/sdk --filter @kakure/prover --filter @kakure/cli --filter @kakure/helper build

# 2. A Solana test validator with the kakure_pool program + verifiers loaded, an indexer, and a
#    coordinator. e2e/localnet.ts's startLocalnet() does all three; for manual/demo use, run the
#    validator and the indexer/coordinator CLIs directly (see packages/indexer, packages/coordinator).
#    NEVER run a second solana-test-validator on this machine at the same time as another one.
solana-test-validator ...   # or: pnpm --filter @kakure/e2e exec node -e "..." (see e2e/localnet.ts)
node packages/indexer/dist/cli.js --rpc-url http://127.0.0.1:8899 --port 8788
node packages/coordinator/dist/cli.js --port 8789

# 3. The Kakure Helper (proving service for transfer_multisig). Prints a fresh bearer token —
#    paste it into the app's Settings page (or a treasury's Settings tab).
just helper-dev
# or: pnpm --filter @kakure/helper exec node dist/cli.js

# 4. The web app itself.
just web-dev
# or: pnpm --filter @kakure/web dev
```

Open the printed Vite URL, connect a wallet (Phantom, wallet-standard), and in Settings fill in the
indexer/coordinator/helper URLs (defaults match the ports above) and paste the helper's token.

## Testing

```sh
just test-web              # component tests (vitest + testing-library), no network needed
pnpm --filter @kakure/web build   # production build (tsc + vite build)
just e2e-payroll            # Playwright e2e against a real localnet + helper (see below)
```

The Playwright suite (`e2e/payroll.spec.ts`) drives the spec §5 demo flow end to end: create a
3-of-5 treasury, fund it, pay 3 recipients in one proposal, and have one recipient open their claim
link. It starts its own localnet + helper + preview server, so run it in the foreground with a long
timeout, and never alongside another `solana-test-validator` on this machine (`pgrep -f
solana-test-validator` first).

## What's stubbed

Only `WasmProver` (`src/prover/wasmProver.ts`) — every method throws `NotImplementedError` pointing
at spec §3A. This is deliberate: the SDK `ProverPort` interface is fully wired everywhere it's
needed (deposit, withdraw, transfer_multisig), so swapping in the real browser-wasm prover (once
`@kakure/prover-wasm` merges) only touches `src/prover/router.ts`'s `wasmRoute()` function — no
other file changes. Every other surface (treasury creation/DKG, funding, payroll batch execution,
claim scanning, accountant ledger) is real code against real `@kakure/sdk`/`@kakure/cli` calls, not
a mock.
