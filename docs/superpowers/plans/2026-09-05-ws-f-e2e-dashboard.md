# Workstream F — e2e + dashboard: bite-sized plan

Owner: workstream F. Scope: `apps/dashboard/`, `e2e/`, the `# --- workstream F: e2e ---`
justfile block, this file. Everything else is read-only reference.

Each task: write a failing test first, run it (see it fail for the right reason), implement,
run again (green), commit.

## 0. Prep
- [x] Read spec §5/§7, master plan Workstream F + I-1..I-9, sdk `index.ts`/`ScanEngine.ts`/
      `SolanaAccount.ts`, `solana/*`, indexer README + `api/server.ts` + `cli.ts`, coordinator
      README + `cli.ts`.
- [x] Confirm `packages/sdk` has no built `dist/` yet — dashboard/e2e both depend on it via the
      workspace `@kakure/sdk` exports map, so `pnpm --filter @kakure/sdk build` must run before
      either consumer can import it (documented in each README, wired into `pnpm -r build`).
- [x] Note in-flight deviation from B: the real `kakure_pool` program (readable at
      `/mnt/e/github2/kakure-wt/b-program`) has **no `emit_cpi!`** (no Anchor) — events go out via
      `sol_log_data` under `kakure:<Name>` tags, borsh-encoded, per its `events.rs`. E's indexer
      currently decodes Anchor-shaped `emit_cpi!` self-CPI logs. This is a B/E integration gap, not
      F's to fix, but it means `e2e/scenario.test.ts` cannot drive the real program end-to-end yet
      (see step 3 `PoolClient` TODO(contract)). Flag in final report.

## 1. Dashboard skeleton (`apps/dashboard`)
- [x] Scaffold Vite + React + TS app (`@kakure/dashboard`), workspace dep on `@kakure/sdk`.
      Failing test first: `src/App.test.tsx` renders `<App />` and asserts the connect form is
      present (indexer URL + key inputs) — fails because nothing exists yet.
- [x] Implement minimal `App` shell (connect form only) → test green → commit.

## 2. View-only account + scan wiring
- [x] `src/lib/viewOnlyAccount.ts`: `ViewOnlyAccount implements IDarkAccount` built from a bare
      view-key `Fr`, never a root/spend secret. Test: constructing it and calling
      `getSelfSpendKey()`/`getIncomingKey()` matches deriving the same values directly from the
      view key via `deriveSelfSpendKey`/`deriveIncomingKey` (no live account needed).
- [x] `src/lib/singleKeyScan.ts`: wraps `ScanEngine` + `KeyRepository` + `UtxoRepository` +
      `httpNotesTransport` + `ComplianceKeyRing` (built from `GET /compliance`) behind one
      `scanSingleKey(indexerUrl, viewKeyHex)` function returning notes/balances. Test with a fake
      `fetch` (fixture notes minted against a known view key, reusing the sdk's own note-encryption
      helpers to build fixtures) asserting balances and history come back correctly.
- [x] `src/lib/multisigScan.ts`: same shape over `MultisigScanEngine.create` for a pasted group
      config (`{v, gpk, compliancePk, memberIds}` hex-encoded). Test with a fixture multisig note.

## 3. Dashboard UI
- [x] Asset table (asset_id ↔ mint, user-editable, persisted to `localStorage`) — component test.
- [x] Balances view (grouped by asset_id, mint label from the table) — component test.
- [x] Note history table (leaf index, value, asset, spent/unspent via `GET /nullifiers/:hex`) —
      component test with fake indexer.
- [x] Root/leaf-count header (`GET /root`) — component test.
- [x] Security test: render `<App />` fully (both single-key and multisig tabs) and assert
      `queryByLabelText(/spend key/i)` and similarly-named fields are never present — this is the
      "never renders a spend-key input" contract test called out in the brief.
- [x] `pnpm --filter @kakure/dashboard build` succeeds (Vite production build).

## 4. E2E harness infra (`e2e/`)
- [x] `e2e/localnet.ts`: start `solana-test-validator --reset` on a free port with
      `--bpf-program <id> <so>` for `kakure_pool`, `mock_verifier` (from
      `/mnt/e/github2/kakure-wt/b-program/target/deploy`) and the 7 real verifiers (from
      `/mnt/e/github2/kakure-wt/a-circuits/circuits/target`), all paths configurable with the above
      as defaults; airdrop to a payer; create an SPL mint + funded token account; spawn indexer +
      coordinator CLIs (built dist) on free ports; return `{rpc, indexerUrl, coordinatorUrl, payer,
      mint, stop()}`; `stop()` (and `SIGINT`) kills every child.
- [x] `e2e/smoke.test.ts`: boots `Localnet`, asserts all 9 programs `executable: true`, `GET /root`
      responds, `POST` to the coordinator accepts a message. `just e2e-smoke` runs it alone
      (`vitest run smoke.test.ts --no-file-parallelism`).

## 5. Scenario skeleton (`e2e/scenario.test.ts`)
- [x] Write the §7 scenario as named steps (DKG over 5 in-process signers via the real
      coordinator; scanning; FROST signing; proving with the mock verifier) with a `PoolClient`
      interface isolating on-chain submission behind one `TODO(contract)` method
      (`submit(ix): Promise<Signature>`), left unimplemented pending B's final instruction/account
      contract. Steps up to "build the transaction" are real and tested.

## 6. Wrap-up
- [x] `justfile` additions under the F marker: `e2e-smoke`, `e2e-scenario` (skipped/pending until
      contract lands), `dashboard-build`, `dashboard-dev`.
- [x] Final report.
