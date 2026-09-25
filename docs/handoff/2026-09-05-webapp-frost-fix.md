# Handoff: make the web-app payroll demo pass (Claude Code, any environment)

Paste everything below the line into a fresh Claude Code session on a clone of `unspecifiedcoder/kakure`.

---

You are working in the Kakure repo (branch `ws/i-webapp`, base `main`). First run `bash scripts/bootstrap.sh` (installs the pinned toolchain and downloads prebuilt circuit/program artifacts from the `artifacts-v1` GitHub release; ~15–30 min). Do not introduce any prior-project name into anything you write.

**Also required:** the recipient claim page's `assembleWithdraw` is unimplemented (flagged in `apps/web`); lift the working single-key withdraw assembly from `e2e/scenario.test.ts` step 6 into `packages/cli/src/proposal/assembleWithdraw.ts` (or `packages/sdk`), unit-test it, and wire the claim page to it.

**Goal:** `just e2e-payroll` (Playwright, `apps/web/e2e/payroll.spec.ts`) passes end to end on a local `solana-test-validator`: create a 3-of-5 private treasury via DKG → fund it → "Pay people" batch to 3 recipients → a recipient opens their claim link and withdraws. Then wire the real browser prover into the claim page.

**Current failure:** the batch-payment step fails with `ProofError: proof failed for transfer_multisig: Circuit execution failed: FROST signature invalid`. Off-chain aggregation succeeds; the circuit's own check rejects the signature. The reference path that DOES work is `e2e/scenario.test.ts` step 5 (core e2e, 9/9 green on main) and the CLI library `packages/cli/src/proposal/{assembleTransferMultisig,execute}.ts`. The web app's `apps/web/src/lib/treasuryFlows.ts` (`payOneRecipient`) re-implemented parts of that path.

**Leading hypothesis (test this FIRST):** the web app proves via the Helper over HTTP: `apps/web/src/prover/helperProver.ts` does `JSON.stringify({ circuit, inputs })` on the TYPED inputs from `buildTransferMultisigInputsFromProposal` (`packages/cli/src/proposal/transferMultisigProposal.ts`): note fields are `Fr` (serialize as hex via `toJSON`), but `frostR` is `[bigint, bigint]` and `gpk` is `[bigint, bigint]`. Check how those survive JSON (a `BigInt.prototype.toJSON` polyfill? decimal strings?) and how `packages/prover/src/marshal.ts` `pointHex` treats them on the helper side (`.toString(16)` on a *string* ignores the radix → wrong point). Write a unit test that builds the typed inputs for a fixture, encodes them with the helper wire (`packages/helper/src/wire.ts`), decodes on the "server" side, runs the prover's InputMap builder on both, and asserts equality. If they differ, that is the bug: fix the wire with an explicit codec (bigint → `0x` hex string, `Fr` → hex, `Uint8Array` → base64, with reviver) and make `HelperProver` use it.

**Method (do not skip):**
1. Reproduce: `just e2e-payroll` (foreground, long timeout). Confirm the failing step.
2. Prove the reference path is green on this branch: `just e2e-scenario` must be 9/9. If it is not, the problem is on main/artifacts — stop and report.
3. Diff the two paths precisely: the FROST message `m` is `msg_transfer(root, nullifier, memo_leaf, memo_tag, change_leaf, asset_id)` (`packages/sdk/src/frost/message.ts` mirrors `circuits/shared/src/multisig/frost.nr`). The circuit recomputes `m` from the witness it receives. The signature is only valid if the app signed the SAME `m` the circuit derives — so any difference between the notes/eph/tag the app hashed for `m` and the notes marshalled into the proof inputs (memo ephemeral even-y rolling, tag derivation, change note parents, root vs root_index, asset_id bytes) breaks it. Also check the nonce commitments/binding factors are computed over the same `m` and the signer set used for aggregation equals the set that committed.
4. Fix by REUSING `assembleTransferMultisig` + the CLI proposal state machine + `executeProposal` from `@kakure/cli` rather than maintaining a second implementation; refactor `packages/cli` exports if needed (keep its tests green: `pnpm --filter @kakure/cli test`).
5. Add a unit test in `apps/web` that asserts the app's signed message equals `assembleTransferMultisig(...).message` for a fixed fixture.
6. Re-run `just e2e-payroll` until green.
7. Wire `@kakure/prover-wasm` (`wasmProverPort({ worker: true, onProgress })`) for the claim page (withdraw) and personal deposits, lazily loaded on those routes; keep the Helper prover for `transfer_multisig`. Add a component test for the progress states. `pnpm --filter @kakure/web build` must pass.
8. Commit in small steps; push `ws/i-webapp`; report: the passing Playwright summary (with per-step timings), the root cause in one paragraph, files changed.

Acceptance: `just e2e-payroll` green; `pnpm --filter @kakure/web test` and `build` green; `just e2e-scenario` still 9/9; the prior-project-name grep empty.
