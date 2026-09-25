# Money-path review — 2026-09-05 (branch `ws/i-webapp`)

Findings from the FROST-signature fix pass, ordered by severity. Each one is also in
`scripts/open-review-issues.sh` as a GitHub issue. Line numbers are as of commit `fae1ce6`.

## Blockers before any mainnet exposure

### 1. Pool authority can swap verifiers / compliance key with no delay
`programs/kakure_pool/src/processor.rs:168` (`set_verifier`) and `:179` (`rotate_compliance_key`)
are single-signer, immediate. Whoever holds `pool.authority` can register `mock_verifier` for a
circuit and drain the vault in the next slot. Needs a multisig/governance authority and an upgrade
timelock (announce → wait → apply), with the pending change visible to indexers/UI.

### 2. Coordinator accepts anonymous appends
`packages/coordinator/src/api/server.ts:60,86`: `POST/GET /sessions/:id/messages` is gated only by
knowing the session id. Envelopes are sealed (confidentiality holds) but anyone with the id can
append junk, force sequence conflicts, or replay envelopes and stall a DKG or signing session.
Require per-participant signed envelopes (verified server-side against the ceremony pubkeys) or a
per-session bearer token issued at session creation.

### 3. Signing breaks when more than `threshold` signers approve
`packages/cli/src/proposal/proposal.ts:137,205`: `signProposal` signs over *whatever* `>= threshold`
nonce commitments it has seen; `aggregateProposal` collects `>= threshold` shares. With 4 of 5
approving, early signers bind over {A,B,C} and a late one over {A,B,C,D}; share verification
fails (identifiable abort). Fix per RFC 9591: fix the signer set up front (proposer or aggregator
publishes exactly `threshold` commitment ids) and have every signer sign over that published set.

## Correctness bugs in the browser path

### 4. Treasury page uses `PublicKey.default` as the pool program id
`apps/web/src/routes/TreasuryPage.tsx:87,124`. Fund / Pay people target the zero program.
Program id belongs in `Settings` (`appStore.ts`) next to `rpcUrl`.

### 5. Wallet-created lookup table is never populated
`apps/web/src/lib/treasuryFlows.ts:519` `ensureLookupTable` creates an empty ALT per action and the
treasury flows never `extendLookupTableViaWallet` it, so a real proof tx cannot fit 1232 bytes in
the browser (only the Playwright harness, which pre-builds a populated ALT, works). Extend with
the same address set the claim page now uses, wait the 20-slot warm-up, and reuse one ALT per
treasury (creation is rent + a tx each time).

### 6. Treasury-side ephemeral counters are not durable
`treasuryFlows.ts:153,471`, `TreasuryPage.tsx:129`, `apps/web/e2e/payroll.spec.ts:238`: every
deposit/batch starts from a fresh `InMemoryEphemeralCounterStore`. Deposit and the first change
note both use self index 0 for the same member → same ephemeral, same CEK, repeated DEM keystream,
identical `ephemeralPK_x` on-chain (the two-time-pad hazard `SealedEphemeralCounterStore`
documents). Use a durable store scoped per group (`apps/web/src/lib/ephemeralCounters.ts`).

### 7. Helper bearer token persisted to localStorage
`apps/web/src/store/appStore.ts:72` writes the whole settings object, `helperToken` included. The
token is a per-launch secret (spec §3B); keep it in memory / sessionStorage only.

### 8. Claim links scan `0..1_000_000` with a 12-char address hint
`TreasuryPage.tsx:163`, `payroll.spec.ts:270`. Full-pool scan on every claim; silently misses
payments once the pool has more than 1M leaves. Use the memo leaf index (known from
`resolveChangeNote`/the NoteInserted event) as `fromLeaf`/`toLeaf`.

### 9. Reference e2e step 6 is flaky on even-y
`e2e/scenario.test.ts:586` uses `getSelfEphemeral(0n)`; the circuit requires the self tag to be
even-y, which index 0 satisfies for ~50% of random recipient keys. The app now rolls via
`KeyRepository.nextSelfEphemeral()`; the scenario should too.

## Documentation

### 10. `intent_hash` is dead on-chain
`processor.rs:685` rejects any non-zero `intent_hash`; the destination binding is entirely
`recipient_field(destination)`. Sound, but document it in the instruction docs and the circuit
so readers do not assume the field carries meaning.
