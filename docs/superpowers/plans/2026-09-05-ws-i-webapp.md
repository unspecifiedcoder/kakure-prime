# Workstream I — Kakure customer web app: implementation plan

Spec: `docs/superpowers/specs/2026-09-05-kakure-customer-app-design.md`. Base: `af647b9`.

## Reuse map (confirmed via code survey)
- `apps/dashboard`: vite config + `util` browser shim (`src/shims/util-browser-shim.ts`), vitest
  config (`jsdom`, `setupFiles`, 60s timeouts), `lib/viewOnlyAccount.ts`, `lib/singleKeyScan.ts`,
  `lib/multisigScan.ts`, `lib/scanOnlyRepositories.ts`, `lib/complianceRing.ts`. All ported as-is
  into `apps/web/src/lib/`, then `apps/dashboard` is deleted (step 8).
- `@kakure/sdk/tx` (`ports.ts`): `ProverPort`, `CircuitId`, `ProofBundle` — the interface both
  provers implement.
- `@kakure/prover`: `nativeProverPort`/`prove()` — wrapped by the helper service, never imported
  directly by the browser bundle (keeps `sunspot`/native fs out of the web build).
- `@kakure/cli`: `runDkgCeremony`, `createProposal/signProposal/executeProposal`,
  `assembleTransferMultisig`/`createTransferMultisigProposal`/`buildTransferMultisigInputsFromProposal`,
  `CoordinatorClient` — imported directly by `apps/web` (confirmed importable as a library, no
  argv/process.exit coupling). No refactor needed for v1; keystore file I/O (`fs`) is NOT reused —
  the web app has its own IndexedDB keystore.
- `e2e/localnet.ts` + `e2e/scenario.test.ts`: exact call sequence for init/deposit/transfer/withdraw,
  ALT usage (`createSharedLookupTable`/`extendSharedLookupTable`/`sendV0`), `rootIndexFor` — the
  Playwright e2e's setup and in-page flow mirror this.

## Known SDK gap (must fix, small)
`SolanaAccount.fromKeypair`/`fromSeed` need a raw ed25519 seed; a wallet-adapter only exposes
`signMessage(): Promise<Uint8Array>` (a signature, not a seed). Add
`SolanaAccount.fromAccountSignature(signature: Uint8Array): Promise<SolanaAccount>` to
`packages/sdk/src/keys/SolanaAccount.ts` that runs the same KDF the existing paths use, keyed off
the raw signature bytes over `ACCOUNT_SEED_MESSAGE` (`Kdf.derive(ROOT_LABEL, toReducedFr(sigBytes))`)
instead of the ed25519-signed seed. Covered by a unit test in the sdk package.

## Steps
1. `packages/helper`: Fastify service on 127.0.0.1. Random token printed at startup; `POST /prove`
   requires `Authorization: Bearer <token>`, body `{circuit, inputs}` -> `nativeProverPort().prove()`
   -> JSON `{circuitId, proof: base64, publicInputs: base64[]}`. Vitest with fastify `.inject()`.
2. `apps/web` scaffold: vite+react+ts, copied vite/vitest config + shim, Zustand, routes
   `/ (treasury list/connect)`, `/treasury/:id`, `/claim/:token`, `/audit`, wallet-standard/Phantom
   connect hook. Encrypted IndexedDB keystore: scrypt (`@noble/hashes/scrypt`) + XChaCha20-Poly1305
   (`@noble/ciphers/chacha`) — same primitives as CLI keystore, adapted to `idb-keyval`-style
   storage instead of `fs`.
3. `ProverPort` implementations in `apps/web/src/prover/`: `helperProver.ts` (HTTP client posting to
   the helper's `/prove`, token entered once and kept in memory/session), `wasmProver.ts` (stub:
   every method throws `NotImplemented("browser wasm proving — see spec §3A")`).
4. Treasury flows (`src/routes/treasury/*`): connect -> create (drives `runDkgCeremony` from
   `@kakure/cli` in-browser, one coordinator session, invite link = session id + participant slot)
   -> fund (deposit UI -> assemble -> `HelperProver` -> `TxBuilder.deposit` -> wallet signs ALT +
   tx) -> Pay people (CSV/table -> one proposal per recipient sharing one coordinator session,
   sequential `assembleTransferMultisig`/`createTransferMultisigProposal`, one signing round per
   proposal, execute loop re-fetching pool/witness between confirms, per-row status) -> balances
   (via `multisigScan.ts`) -> settings (export/import encrypted group record).
5. Claim page (`src/routes/claim/[token].tsx`): token = base64url `{indexerUrl, incomingAddressHint,
   fromLeaf, toLeaf}`, no secrets. Connect Phantom -> `SolanaAccount.fromAccountSignature` ->
   `scanSingleKey` over the given leaf range -> show amount in plain language -> withdraw (single-key
   withdraw circuit via HelperProver) or "keep private".
6. Accountant view (`src/routes/audit.tsx`): paste scoped view key + leaf range -> read-only ledger
   via `scanSingleKey`/`scanMultisigGroup` -> CSV export. Component test asserts no `type=password`
   /spend-key field exists on this page or the claim page.
7. Playwright `apps/web/e2e/payroll.spec.ts`: `startLocalnet` + helper service + preview server;
   3-recipient payroll demo end to end. Run in foreground, long timeout, only when no other
   `solana-test-validator` is running.
8. Delete `apps/dashboard`; `pnpm --filter @kakure/web build`; `apps/web/README.md` with the full
   local run recipe.

## Language rule
UI copy says "private payment" / "generating privacy proof" — never "note"/"nullifier"/"proof" at
top level; those go under a collapsible "Details".
