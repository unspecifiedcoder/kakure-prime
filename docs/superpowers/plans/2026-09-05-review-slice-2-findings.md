# Review slice 2 — byte encodings and privacy surfaces

**Base:** `main` @ `141e560`. **Scope:** master-plan slice 2 (A: encodings, B: privacy surfaces, C: spec §3.3 recipient binding).
**Method:** read-only source cross-check (TS vs Rust/Go, Rust wins), one `sunspot verify` experiment against the committed
`circuits/target/withdraw.{vk,proof,pw}` artifacts, one vitest file (`packages/prover/src/__tests__/compress.test.ts`).
Each finding is tagged **verified** (reproduced or confirmed line-by-line against both sides) or **plausible** (reasoned
from code, not exercised).

Not reviewable at this commit: `apps/web`, `packages/helper`, `apps/web/src/lib/{keystore,claimToken}.ts` and
`SolanaAccount.fromAccountSignature` do not exist (only `apps/dashboard` and `SolanaAccount.fromKeypair`). The backlog items on
the Helper prover and claim links are therefore unverifiable; see F-12.

---

## F-1 — CRITICAL — single-key `withdraw` does not bind `recipient`: any observer can redirect the payout  (verified)

**Files:** `circuits/standard/withdraw/src/main.nr:10-11` (`_recipient: pub Field`, `_intent_hash: pub Field`, both unused);
`/root/sunspot/go/acir/acir.go:145-192` (compiles with `r1cs.NewBuilder` and no unconstrained-input handling);
`/root/go/pkg/mod/github.com/consensys/gnark@v0.14.0/constraint/core.go:430-433` (`CheckUnconstrainedWires` is `return nil` — a TODO stub);
`programs/kakure_pool/src/processor.rs:693-695` (the only recipient check).

**What is wrong.** Spec §3.3 says single-key withdraw binds the recipient "only on-chain", assuming the proof's public input
`recipient` is bound to the proof so the pool's `recipient == recipient_field(destination)` check is meaningful. Under Groth16 a
public wire that appears in no constraint has `vk.K[i] = ∞`, so the verifier's `Σ pubᵢ·K[i]` term ignores it: the proof verifies for
**every** value of that input. Noir leaves `_recipient`/`_intent_hash` untouched (fine for UltraHonk, where public inputs enter the
permutation argument, which is what the reference implementation relied on), gnark 0.14's guard is a no-op, and Sunspot does not add
one. Nothing else re-binds it: `withdraw_multisig` folds `recipient` into the FROST message, `withdraw` has no signature at all.

**Reproduction (done, ~2 s each).** Flip the low bit of entry 1 (`recipient`) or entry 2 (`intent_hash`) in `withdraw.pw`:

```
sunspot verify withdraw.vk withdraw.proof withdraw.pw        -> "Verification successful"
sunspot verify withdraw.vk withdraw.proof mut_recipient.pw   -> "Verification successful"   <-- must fail
sunspot verify withdraw.vk withdraw.proof mut_intent.pw      -> "Verification successful"   <-- must fail
sunspot verify withdraw.vk withdraw.proof mut_value.pw       -> "pairing doesn't match"   (control)
sunspot verify withdraw.vk withdraw.proof mut_nullifier.pw   -> "pairing doesn't match"   (control)
```

**Failure scenario.** Recipient R builds a `withdraw` tx (`TxBuilder.withdraw`, `packages/sdk/src/solana/txBuilder.ts:411-437`) with
`public_inputs[1] = recipient_field(R_ata)` and `destination_token_account = R_ata`. Anyone who sees the tx before it lands — the RPC
node, a leader/Jito searcher, or a fee-paying relayer (e2e already uses a separate `payer`) — copies `proof`, replaces
`public_inputs[1]` with `recipient_field(ATTACKER_ata)`, sets `destination_token_account = ATTACKER_ata`, keeps `amount`, and
submits first. The pool injects cpk/root, the verifier CPI succeeds (F-1 above), `create_nullifier` burns R's note, and
`transfer_checked` pays the attacker. R's original tx then fails `NullifierSpent`. Every single-key withdrawal in the pool is
stealable by whoever sees it first; no key material is needed. `intent_hash` is harmless only because the pool hard-codes `== 0`.

**Fix spec.**
1. `circuits/standard/withdraw/src/main.nr`: rename `_recipient`→`recipient`, `_intent_hash`→`intent_hash` and add, right after
   `assert_valid_compliance_pk`, constraints that survive SSA simplification:
   ```noir
   // Bind the on-chain-checked public inputs into the constraint system. Under Groth16 an
   // unreferenced public wire has K[i] = infinity and is NOT bound by the proof (slice-2 F-1).
   assert(recipient != 0, "recipient must be nonzero");   // emits recipient * inv == 1
   assert(intent_hash == 0, "intent_hash must be zero in v1"); // emits intent_hash == 0
   ```
   (`recipient_field` is `sha256(...)` with byte 0 zeroed and is never 0 in practice.) Rebuild `withdraw.{ccs,pk,vk,so}`, regenerate
   the withdraw KAT in `circuits/kat`/manifest, redeploy the verifier.
2. Defence in depth in Sunspot (`/root/sunspot/go/acir/acir.go`, after `a.Program.Define`): walk the R1CS and fail `Compile()` if any
   `PublicVariable` has zero occurrences in A/B/C (do not rely on gnark's stub). Pin that Sunspot revision in the manifest.
3. Regression test (real code, uses only existing artifacts; runs in ~30 s): `packages/prover/src/__tests__/publicInputBinding.test.ts`
   ```ts
   import { describe, expect, it } from "vitest";
   import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { artifactPaths } from "../artifacts.js";
   import { verifyWithSunspot } from "../sunspot.js";

   // Every public input of every circuit that has a committed .proof/.pw fixture must be bound by
   // the proof: flipping one bit of any entry must make `sunspot verify` fail. Guards against
   // unconstrained `pub` parameters (slice-2 F-1: withdraw's `_recipient`).
   const CIRCUITS = ["withdraw", "deposit", "transfer_multisig"];

   describe("every public input is bound by the proof", () => {
     for (const name of CIRCUITS) {
       const p = artifactPaths(name);
       const pwPath = p.ccs.replace(/\.ccs$/, ".pw");
       const proofPath = p.ccs.replace(/\.ccs$/, ".proof");
       if (!existsSync(pwPath) || !existsSync(proofPath)) continue;
       const pw = readFileSync(pwPath);
       const n = pw.readUInt32BE(0);
       it(`${name}: baseline verifies`, async () => {
         expect(await verifyWithSunspot(name, p.vk, proofPath, pwPath)).toBe(true);
       });
       for (let i = 0; i < n; i++) {
         it(`${name}: mutated public input ${i} fails verification`, async () => {
           const dir = mkdtempSync(join(tmpdir(), "pw-mut-"));
           const mut = Buffer.from(pw);
           mut[12 + i * 32 + 31] ^= 0x01;
           const mutPath = join(dir, `${name}.pw`);
           writeFileSync(mutPath, mut);
           await expect(verifyWithSunspot(name, p.vk, proofPath, mutPath)).rejects.toThrow(/sunspot verify exited/);
         });
       }
     }
   });
   ```
   Note `verifyWithSunspot` throws on non-zero exit (`sunspot.ts:60-62`), which is what the mutated cases assert.
4. Add the equivalent litesvm test (`tests-litesvm`): a real withdraw proof with `public_inputs[1]` swapped to
   `recipient_field(other_ata)` and `destination = other_ata` must fail with the verifier's error, not succeed.

**Acceptance:** `cd packages/prover && npx vitest run src/__tests__/publicInputBinding.test.ts --no-file-parallelism` is green
(after the circuit rebuild); before the fix the two `withdraw` cases for inputs 1 and 2 fail.

**Answer to C.** Yes — precisely because the circuit does not reference `recipient`, the on-chain equality check is the *only*
binding and it binds the public input to the destination account, not the proof to the public input. A relayer or front-runner can
substitute both consistently. `withdraw_multisig` is not affected (`msg_withdraw` includes `recipient`, and `verify_frost_spend`
constrains the message), but note the FROST *signature*, not the ZK proof, is what protects it — the proof's `recipient` wire is
bound only through the Poseidon message hash, which is a constraint, so K[recipient] ≠ ∞ there.

---

## F-2 — HIGH — coordinator envelopes are plaintext: the operator learns membership, threshold, group key, amounts, recipients  (verified)

**Files:** `packages/cli/src/dkg/ceremony.ts:101-107` (round 1: ed25519 pubkey + X25519 pubkey in the clear), `:150-158` (round 2:
Feldman `commitments`, `pop`, dealer id in the clear; only the per-recipient `boxes` are sealed);
`packages/cli/src/proposal/proposal.ts:59` (proposal `{kind, messageHex, details}` plaintext), `:133` (FROST nonce commitments
`D,E` + signer id plaintext), `:150` (signature share `z` plaintext); `packages/coordinator/src/schema.ts` (field is named
`ciphertext` but nothing checks it is one).

**What the operator (or anyone with the session id, see F-3) learns.**
- *Membership:* every member's `edPubHex` = their Solana wallet address (`group.ts:66`, `keypair.publicKey`).
- *Threshold:* `commitments.length === threshold` in each round-2 message; `memberCount` = number of `dkg1` envelopes.
- *Group public key:* `gpk = Σ_dealers commitments[0]` (Feldman constant terms are public in the message). This is the very
  value spec §1 says must be "invisible on-chain" and §5 says the coordinator "never learns".
- *Every spend:* `details` (asset, amount, recipient — free-form, but the CLI `propose` command puts exactly that there), the
  signed message, which signer ids participated and when.
Spec §5 "Coordinator privacy contract" ("relays only ciphertext… never learns group public keys, amounts, recipients or membership")
and customer-app §4 ("Coordinator sees ciphertext only") are both false today. The type-level logger discipline (F-8) protects
nothing when the payload itself is plaintext.

**Fix spec.**
1. Round 1 has no shared key by design; make it carry the *minimum*: a fresh per-ceremony X25519 key and an ed25519 signature
   (F-3), and derive the announced identity as `H(sessionId ‖ edPub)` rather than the raw wallet key if wallet linkability matters.
2. Round 2: seal the *whole* `DealerMessage` per recipient (commitments + pop inside each box), not just the share. Recipients need
   all dealers' commitments anyway; nothing in the ceremony requires them to be public to the relay.
3. Post-DKG: every `proposal`/`nonce`/`share`/`final` envelope must be `xchacha20poly1305(K_session, nonce, json)` with
   `K_session = HKDF(gvs, "kakure.coordinator.session.v1" ‖ sessionId)` (gvs is already in `GroupRecord.groupViewKey`). Add
   `packages/cli/src/crypto/sessionSeal.ts` and route `createProposal`/`fetchProposal`/`signProposal`/`aggregateProposal` through it.
4. Failing test, `packages/cli/src/proposal/__tests__/privacy.test.ts`:
   ```ts
   it("no envelope body posted to the coordinator is parseable JSON or contains the message/recipient", async () => {
     const posted: string[] = [];
     const fake = { appendNext: async (_s, _k, ct) => { posted.push(ct); return {} as never; }, collectUntil: async () => [] };
     await createProposal(fake as never, SESSION, { kind: "withdraw", proposalId: "p1", messageHex: "0x1234", details: { recipient: "R" } });
     for (const ct of posted) {
       const bytes = Buffer.from(ct, "base64");
       expect(() => JSON.parse(bytes.toString("utf8"))).toThrow();
       expect(bytes.toString("utf8")).not.toContain("0x1234");
       expect(bytes.toString("utf8")).not.toContain("recipient");
     }
   });
   ```
   and the same shape for `ceremony.ts` round 2 asserting the `commitments` field is absent from the plaintext JSON.

**Acceptance:** `cd packages/cli && npx vitest run src/proposal/__tests__/privacy.test.ts --no-file-parallelism`.

---

## F-3 — HIGH — DKG round-1 announces are unauthenticated and last-writer-wins: a session-id holder can steal members' key shares  (verified by code path, not executed)

**Files:** `packages/cli/src/dkg/ceremony.ts:101-107` (announce carries `edPubHex` but no signature), `:120` (`new Map(announces.map(a => [a.edPubHex, a]))`
— a later announce for the same `edPubHex` *replaces* the earlier one), `:141-149` (dealers seal member *i*'s share to whatever
`x25519PubHex` won at line 120); `packages/coordinator/src/api/server.ts:60-84` (POST needs only the session id; `:120-141` WS likewise).

**Failure scenario.** The session id is a bearer capability printed to stdout and pasted between members
(`cli.ts:59-61`); the coordinator operator also has it (F-8). During the ceremony window an attacker posts a `dkg1` envelope
`{kind:"announce", edPubHex: <victim's wallet key>, x25519PubHex: <attacker key>}` *after* the victim's own announce. Every other
member's `sorted` list now maps the victim's identity to the attacker's X25519 key, so each dealer's round-2 box for the victim is
sealed to the attacker. The attacker reads the boxes off the coordinator (no auth) and reconstructs the victim's full FROST secret
share `Σ_dealers share_i`. The victim's own run fails at `openFrom` — but only after every dealer has already posted. Repeat for `t`
members in a `t`-of-`n` group and the attacker holds a signing quorum; the honest members see "dealer … failed verification" /
decryption errors and, at best, restart with a new session — the old `gpk` must be treated as compromised, but nothing tells them
that. With `n > t`, replacing `n-t+1` slow members also works as pure exclusion.

**Fix spec.**
1. `ceremony.ts`: announce = `{edPubHex, x25519PubHex, sig}` with `sig = ed25519.sign("kakure.dkg1.v1" ‖ sessionId ‖ x25519Pub, seed)`;
   receivers verify with `edPubHex` and **reject** (abort the ceremony) on any second announce for an `edPubHex` with a different
   `x25519PubHex` — never dedupe by overwrite. Sign round-2 `DealerMessage` the same way (over `sessionId ‖ dealerId ‖ commitments ‖ boxes`).
2. `group create/join` should take `--members <pubkey,...>` (the customer-app design already lists signer wallet addresses up front)
   and ignore announces from keys outside the allowlist.
3. Coordinator: require a per-session write token (`POST /sessions` returns `{id, write_token}`; members get it with the invite) so
   read/append needs more than the id, and cap `ciphertext` (e.g. 64 KiB) and envelopes per session.
4. Failing test, `packages/cli/src/dkg/__tests__/announceAuth.test.ts`:
   ```ts
   it("a conflicting announce for an existing identity aborts the ceremony instead of replacing its X25519 key", async () => {
     const fake = new FakeCoordinator();           // in-memory, as in transferMultisigFlow.test.ts
     const victim = Keypair.generate(), attacker = Keypair.generate(), other = Keypair.generate();
     // attacker re-announces the victim's identity with attacker's own X25519 key
     fake.inject(SESSION, "dkg1", announceFor(victim.publicKey, x25519FromEd25519Seed(attacker.secretKey.slice(0, 32)).pub));
     await expect(Promise.all([
       runDkgCeremony({ ...base, ed25519Seed: victim.secretKey.slice(0, 32), ed25519PublicKey: victim.publicKey.toBytes() }),
       runDkgCeremony({ ...base, ed25519Seed: other.secretKey.slice(0, 32),  ed25519PublicKey: other.publicKey.toBytes() }),
     ])).rejects.toThrow(/conflicting announce|bad announce signature/);
     expect(fake.envelopes(SESSION).filter((e) => e.kind === "dkg2")).toHaveLength(0); // nobody dealt shares
   });
   ```

**Acceptance:** `cd packages/cli && npx vitest run src/dkg/__tests__/announceAuth.test.ts --no-file-parallelism`.

---

## F-4 — HIGH — indexer silently loses `NoteInserted` under log truncation; attacker-triggerable, permanently desyncs every client  (plausible)

**Files:** `programs/kakure_pool/src/events.rs:4-10` (acknowledges `sol_log_data` has no truncation immunity);
`packages/indexer/src/ingest/ingest.ts:66-82` (no detection of the runtime's `"Log truncated"` line; cursor advances regardless);
`packages/indexer/src/events/logScope.ts` (a truncated log also drops the `Program … success` lines, so nothing signals loss);
`packages/indexer/src/chain/solanaSource.ts` (only `logMessages` are fetched).

**Failure scenario.** Agave caps a transaction's log buffer (default `log_messages_bytes_limit` 10 000 bytes); once hit it
appends `Log truncated` and drops every later line — including `Program data:`. `kakure_pool` has no signer gate on money paths
(spec §6), so anyone can invoke it by CPI from their own program that first emits ~10 KB of `msg!` output (cheap in CU). The
pool inserts a leaf and advances `next_leaf_index`; the indexer sees no event, keeps its cursor moving, and its mirror is now
one leaf short. Every later `/path/:leaf_index`, `/root`, and `ScanEngine.merkleTree.insert` is off by one; all clients' witnesses
fold to a root the pool has never seen (`RootNotInRingError` / verifier failure) and no note inserted after that point is
discoverable through `/notes`. The lost leaf is not recoverable from logs later. A more benign version happens by accident
whenever a wrapper/aggregator program logs verbosely around the CPI.

**Fix spec.**
1. `ingest.ts::processSignature`: if `tx.logMessages` contains `"Log truncated"` (or the scoped lines for a successful kakure
   instruction yield fewer `NoteInserted` than the instruction implies: deposit 1, transfer/split 2, join 1, withdraw 1, initialize 1),
   fall back to decoding the pool instruction data (`PoolInstruction` borsh; leaf/eph/ct are in `public_inputs` at the offsets in
   `processor.rs`) and to `getTransaction(...).meta.innerInstructions` for the leaf index (or read `next_leaf_index` from the Pool
   account at that slot). Extend `RawTransaction` with `instructions`/`accountKeys`.
2. Reconciliation guard: after each processed signature compare `tree.nextLeafIndex` with the on-chain `Pool.next_leaf_index`
   (`decodePool`, already in the SDK); on mismatch stop serving `/path` (503) rather than serving wrong paths.
3. Failing test, `packages/indexer/src/ingest/ingest.test.ts`:
   ```ts
   it("does not advance the cursor past a truncated log without recovering the leaf", async () => {
     chain.addTransaction({
       signature: "sigT", slot: 7, err: null,
       logMessages: [`Program ${PROGRAM_ID} invoke [1]`, "Log truncated"],
       instructions: [depositInstructionFixture({ leafByte: 0x05 })],   // new field
     });
     await ingestor.backfill();
     expect(tree.nextLeafIndex).toBe(1);                 // leaf recovered from instruction data
     expect(store.getNotesFrom(0)[0]?.leaf).toBe(`0x${"05".repeat(32)}`);
   });
   ```

**Acceptance:** `cd packages/indexer && npx vitest run src/ingest/ingest.test.ts --no-file-parallelism`.

---

## F-5 — MEDIUM — per-note indexer lookups leak each wallet's note set and next spend  (verified)

**Files:** `packages/cli/src/commands/balance.ts:32-34,52` (one `GET /nullifiers/<hex>` per *unspent* note the group owns);
`apps/dashboard/src/components/NoteHistory.tsx:26-31` (same, for every scanned note); `packages/sdk/src/solana/witnessSource.ts:26`
(`GET /path/<leaf_index>` for the exact input note immediately before proving); `packages/indexer/src/api/server.ts:58-87`.

**Failure scenario.** The indexer operator logs `(ip, path, time)`. From `balance`, it learns the set of nullifiers a wallet
holds *before* they are spent; when `NullifierSpent(n)` later arrives it knows which transaction, and therefore which two fresh
output leaves (memo + change), belong to that wallet — a complete transaction graph per client IP, defeating the on-chain unlinkability.
`/path/:leaf_index` gives the same link one step earlier (input leaf → the tx that lands seconds later). Customer-app §4 says
"Indexer queries are per-range, not per-note"; `/notes?from=` is, the other two are not.

**Fix spec.**
1. Merkle paths: compute locally. `ScanEngine` already maintains an optional `LeanIMT` mirror (`ScanEngine.ts:141-143`); make it
   mandatory for spending wallets and implement `MerkleWitnessSource` over it (the LeanIMT KAT in `circuits/kat/lean_imt_poseidon_v1.json`
   already pins the hash). Keep `/path` only for the dashboard.
2. Nullifiers: replace `GET /nullifiers/:hex` in wallets with `GET /nullifiers?from_slot=<n>` returning all spent nullifiers since
   a slot (the set is public on-chain anyway); the client checks membership locally. Keep `/nullifiers/:hex` for explorers.
3. Test: in `balance.test.ts`, assert the fetch mock receives no URL matching `/nullifiers/0x[0-9a-f]{64}`; in
   `witnessSources.test.ts`, assert a spend of a note the mirror already contains issues zero `/path/` fetches.

**Acceptance:** `cd packages/cli && npx vitest run src/commands/__tests__/balance.test.ts --no-file-parallelism`.

---

## F-6 — MEDIUM — `decodePoolError` mis-maps verifier CPI errors; `InvalidProof` is never what a client sees for a bad proof  (verified)

**Files:** `packages/sdk/src/solana/errors.ts:84-88` (any `Custom(n)` with `n < 14` is reported as a `PoolError`);
`programs/kakure_pool/src/verify.rs:108` (`.map_err(|_| PoolError::InvalidProof)` is dead — a failed `invoke` aborts the tx with the
callee's error; the file's own doc at `:13-20` says so); `/root/sunspot/gnark-solana/crates/verifier-bin/src/lib.rs:31-56`
(parse errors → `Custom(0..15)`, verification failure → `ProgramError::InvalidInstructionData`);
`/root/sunspot/gnark-solana/crates/verifier-lib/src/error.rs:57-76`.

**Concrete misreports.** Verifier `PublicInputGreaterThanFieldSize` = `Custom(9)` → SDK says `AssetCollision`;
`InvalidPublicInputsLength` = `Custom(6)` → `InvalidLeaf`; `ProofVerificationFailed` = `Custom(1)` → `InvalidPublicInputCount`. A
genuinely bad proof (wrong root, stale compliance key, F-1 mutation) surfaces as `InstructionError: [i, "InvalidInstructionData"]`,
which `decodePoolError` returns `undefined` for, while the backlog and `txBuilder.ts:103-104` promise `InvalidProof`.

**Fix spec.**
1. `errors.ts`: `decodePoolError(err, logs?)` — only map `Custom(n)` to a `PoolError` when `logs` contains
   `Program <kakure_pool id> failed` as the innermost failure (the last `Program X failed:` line before the top-level one); if the
   innermost failing program is `pool.verifiers[*]`, return `"InvalidProof"` for `InvalidInstructionData` and
   `"VerifierError(<GnarkError name>)"` for `Custom(n)`. Export a `GNARK_ERROR_NAMES` table copied from `error.rs`.
2. `verify.rs`: delete the dead `map_err` and fix the comment in `txBuilder.ts:101-104`.
3. Failing test, `packages/sdk/src/__tests__/solana.test.ts`:
   ```ts
   it("does not report a verifier's Custom(9) as the pool's AssetCollision", () => {
     const err = { InstructionError: [1, { Custom: 9 }] };
     const logs = [`Program ${POOL_ID} invoke [1]`, `Program ${VERIFIER_ID} invoke [2]`,
                   "Program log: Gnark error: PublicInputGreaterThanFieldSize",
                   `Program ${VERIFIER_ID} failed: custom program error: 0x9`, `Program ${POOL_ID} failed: ...`];
     expect(decodePoolError(err, logs)).toBe("VerifierError(PublicInputGreaterThanFieldSize)");
     expect(decodePoolError({ InstructionError: [1, "InvalidInstructionData"] }, logs.slice(0, 2)
       .concat(`Program ${VERIFIER_ID} failed: invalid instruction data`))).toBe("InvalidProof");
   });
   ```

**Acceptance:** `cd packages/sdk && npx vitest run src/__tests__/solana.test.ts --no-file-parallelism`.

---

## F-7 — MEDIUM — root secret = wallet signature over a fixed public string: phishable, origin-unbound, hardware-wallet-incompatible  (plausible; design-level)

**Files:** `packages/sdk/src/keys/SolanaAccount.ts:31-33` (`ACCOUNT_SEED_MESSAGE = "kakure.account.v1"`), `:137-147`
(`fromKeypair`: `skRoot = Kdf(ROOT_LABEL, ed25519.sign(msg, seed) mod r)`); customer-app design §1.1 (Phantom `signMessage` over the same string).

**Analysis.** ed25519 is deterministic, so the same wallet always yields the same `skRoot` — good for recovery, but it means:
(a) *phishing:* any site that gets the user to `signMessage("kakure.account.v1")` (a 17-byte opaque prompt that looks like a
"sign in" request) obtains the *spend* root, not a session; wallets cannot warn because the message carries no domain.
(b) *cross-dapp determinism:* the secret is a pure function of the wallet, so two unrelated apps using the SDK share the same
account — intended, but it makes (a) permanent; there is no rotation without moving funds.
(c) *wallet compatibility:* Ledger's Solana app refuses raw-byte messages and signs the "off-chain message" envelope
(`\xffsolana offchain` header + version + length), so the signature — hence every key — differs from `fromKeypair`'s noble output;
some software wallets also prefix. Keys derived in-browser would then not match the CLI's for the same keypair.
(d) The reference EVM implementation had the same shape (ECDSA over a fixed message); this is not a regression, but the spec's
"no seed phrases shown" framing hides that the wallet signature *is* the seed phrase.

**Fix spec.** Sign a Solana off-chain-message-formatted payload that embeds a human-readable warning and the wallet address:
`"kakure.account.v1\nThis signature is your Kakure spending key. Only sign on <app origin>.\nWallet: <base58>"` (so a
substituted address changes the key); document that the derived account is wallet-scoped, not dapp-scoped; add a KAT test that
`fromKeypair` and a mocked wallet-standard `signMessage` over the same formatted bytes agree; refuse to derive from a signer
whose signature is not deterministic (sign twice, compare). Consider a per-app salt in the message if dapp isolation is wanted
(at the cost of recovery needing the app id).

---

## F-8 — LOW — coordinator hardening gaps; logger disjointness holds in-process but not at the transport  (verified)

**Files:** `packages/coordinator/src/cli.ts:16` and `packages/indexer/src/cli.ts:25` (bind `0.0.0.0`, no flag);
`packages/coordinator/src/api/server.ts` (no auth, no rate limit, Fastify default 1 MiB body, unbounded envelopes per session, WS
without origin check or ping); `packages/coordinator/src/logger.ts:36-45` (one JSON line per event; `logSession` has no timestamp —
correct by type as claimed); `packages/coordinator/src/db/store.ts:80-85` (TTL per *message*, not per session).

- Logger: the claim is true for the *line content* and the test at `logger.test.ts:10-39` proves it. But `defaultSink` writes to
  stdout; journald, Docker, and every hosted log pipeline stamp each line, so `(session_id, timestamp)` pairs exist in the
  operator's logs anyway. Either drop `session.*` events from the default sink (count them instead) or document that the
  guarantee requires a sink that is not timestamped.
- Sequence: `seq` gaps → `409` only; because it is a single counter per session, anyone with the id can consume slots (DoS) and
  read every envelope (see F-2/F-3 for why that matters today). Given real E2E encryption, read access would be acceptable; write
  access still allows cheap DoS — add a write token (F-3.3).
- TTL: sweeping by message age lets a session's `seq` restart at 0 after 24 h; a client with a cached `nextSeqGuess`/`since`
  cursor silently misses the restarted stream. Sweep whole sessions (`DELETE … WHERE session_id IN (SELECT session_id … GROUP BY
  session_id HAVING MAX(created_at) < cutoff)`).
- `since` parsing: `Number("abc")` → `NaN` → SQLite binds NULL → returns nothing → long-poll → `[]`. Harmless but return 400.

**Fix acceptance:** add `--host` (default `127.0.0.1`) to both `parseArgs`; `coordinator/src/api/server.test.ts` cases for
413 on a 100 KiB envelope and 400 on `since=abc`; `ttlSweep.test.ts` case that a session with one fresh message keeps its old ones.

---

## F-9 — LOW — no client-side canonical/field-range checks in the encoders; one misleading doc comment  (verified)

**Files:** `packages/prover/src/decode.ts:16-46` (`decodePublicWitness` never checks entries `< r`), `:101-116` (`encodePublicWitness`
accepts any 32 bytes); `packages/prover/src/compress.ts:36-39` (`fqSignFlagBit`: for `y ≥ q`, `(q - y) % q` is negative in JS, so the flag
is computed on garbage), `:75-104` (no `x,y < q` / on-curve check); `packages/sdk/src/solana/txBuilder.ts:123-138` (length only).

Today every value comes from `sunspot prove`, so this is defence in depth: an out-of-range value would be rejected on-chain
(`GnarkError::PublicInputGreaterThanFieldSize`, syscall decompression failure) with the confusing errors of F-6 rather than a
clear client error. Add `assertCanonicalFr` in `decodePublicWitness`/`assertPublicInputs` and `assertCanonicalFq` in
`compressG1/G2` (throw `ProofError("encode", …)`), plus a unit test feeding `q` and `r` as inputs.

Doc nit: `compress.ts:88-90` says each G2 half is `c0(32) ‖ c1(32)`; the gnark/`solana-bn254` big-endian wire is `c1 ‖ c0` (which
is exactly why `fq2SignFlagBit(y0, y1)` compares the *first* serialized half first — the code is right, the comment is not).
`decode.ts:47-49` reads `u32` with `|`, so `old_version ≥ 2^31` would go negative — irrelevant in practice; use `>>> 0`.

---

## F-10 — LOW — `compress.test.ts` couples to the untracked, overwritten `circuits/target/transfer_multisig.proof` — currently red  (verified)

**Files:** `packages/prover/src/__tests__/compress.test.ts:36-56`; `packages/prover/src/prove.ts:30-35` (documents that every
`prove()` overwrites `<artifactsDir>/<circuit>.proof`); `.gitignore:11` (`circuits/target/*` untracked).

Run on this checkout: 3 pass, 1 fail — the per-element KAT (`uncompressed → compressed`, generated by Rust `solana_bn254`) passes,
so the TS compression is correct; the "full 192-byte concatenation" case reads a `.proof` on disk (mtime 14:35) that predates
the regenerated KAT (`4cbd2f3`, 14:55) and any later `prove()` run replaces it again. Fix: embed the 388-byte fixture's hex in
the KAT JSON (`uncompressed.proof`) and compress that; drop the filesystem read.
**Acceptance:** `cd packages/prover && npx vitest run src/__tests__/compress.test.ts --no-file-parallelism` green regardless of
what is in `circuits/target`.

---

## F-11 — LOW — CLI key handling: passphrase echo/env, modest scrypt cost, raw ECDH output as AEAD key  (verified)

**Files:** `packages/cli/src/cli.ts:15` (`KAKURE_PASSPHRASE` from env — visible in `/proc/<pid>/environ`, shell history, CI logs),
`:17` (`readline.question` echoes the passphrase to the terminal); `packages/cli/src/keystore.ts:13-15` (scrypt `N=2^15,r=8,p=1`
≈ 32 MiB / ~60 ms — below the usual 2^17 for an interactive spend-key store); `packages/cli/src/crypto/seal.ts:31-33,42`
(X25519 shared secret used directly as the XChaCha20-Poly1305 key, no HKDF, no transcript binding).

What is right: fresh 16-byte salt and 24-byte nonce per encryption (`keystore.ts:47-49`), so no nonce reuse; files written
`0600`; group record (secret share + view key) is encrypted at rest; `SolanaAccount` hides key material from serialization.
Fix: mute terminal echo (`readline` with a muted `Writable` or `@inquirer/password`), raise `N` to `2^17` (keep the params in the
file so old stores still open), and derive `key = HKDF-SHA256(shared, info = "kakure.dkg.box.v1" ‖ senderPub ‖ recipientPub ‖ sessionId)`
in `seal.ts`.

---

## F-12 — INFO — customer-app surfaces absent at this commit; what the dashboard does store

`apps/web`, `packages/helper`, `claimToken.ts`, and a browser keystore do not exist at `141e560`, so the backlog items "Helper
prover security" and "Claim links carry no secrets" cannot be verified here; they must be re-reviewed when that code lands
(specifically: `127.0.0.1` bind + per-launch token in an `Authorization` header + `Access-Control-Allow-Origin` pinned to the app
origin + a `Sec-Fetch-Site`/`Origin` check, and a claim token that is `{indexerUrl, addressHint, fromLeaf, toLeaf}` only).
`apps/dashboard` keeps the pasted view key in React state only (`App.tsx:21`), never in storage or the URL; `localStorage` holds only
the asset-label map (`AssetTable.tsx:7-20`). The `prover-wasm` worker posts `inputs` (which include the spend scalar) to a
same-origin dedicated worker via structured clone — this stays in-process, consistent with the "always local" rule.

---

## Checked and found correct

**A — encodings**
- `.proof` layout (`decode.ts:48-92`) = `verifier-lib/src/proof.rs::from_bytes` (A64‖B128‖C64‖count u32 BE‖commitments‖pok64;
  exact-length check). `.pw` layout (`decode.ts:3-46`) = `witness.rs::from_bytes` (12-byte header, 32-byte BE entries). CPI data =
  `proof ‖ full pw` matches `verifier-bin/src/lib.rs:28-38` split arithmetic, and `verify.rs:88-96` rebuilds the header identically.
- G1/G2 compression (`compress.ts`) vs `solana-bn254 3.1.2 compression.rs`: BE↔LE via per-chunk reversal (`<32,64>`, `<64,128>`),
  sign flag `0x80` iff `y > −y` (ark `SWFlags::YIsNegative`), Fq2 ordering decided by the first serialized half (gnark writes
  `c1‖c0`), flag lands in byte 0 after reversal, all-zero infinity shortcut both ways. Per-element Rust→TS KAT and the G2
  regression KAT pass. On-chain `verify.rs::decompress_proof` reverses it exactly (A,B,C,commitment,pok; `count=1`).
- Borsh wire (`borsh.ts`, `txBuilder.ts`) vs `instruction.rs`: u8 tag order 0..10 matches enum declaration; field order
  (`proof[192]` fixed, `Vec<[u8;32]>` u32-LE length, `amount` u64 LE before `root_index` for withdraw, `bool` u8); account order
  per handler matches `processor.rs` (deposit 10 accounts incl. verifier last; spends 5; join 6; withdraw 10); public-input
  strip indices match `inject_full` positions (deposit [0,1]; transfer/split [0,1,3]; join [0,1,4]; withdraw [3,4,6]) and the
  wire counts 11/21/19/11/14.
- `Pool` layout offsets (`poolAccounts.ts` = `state.rs`, `POOL_LEN` 9550), `rootIndexFor` walks backward from `root_cursor`
  (freshest first) and `resolve_root` only rejects a never-written zero slot — a stale-slot race yields a verifier failure
  rather than theft (root is a bound public input, confirmed by the mutation control).
- Error numbering (`errors.ts` = `error.rs`, 14 variants, `ComplianceKeyStale` kept at 2) — see F-6 for attribution.
- Events: `sol_log_data` framing (`Program data: <b64 tag> <b64 body>`), borsh body without discriminator, `Option` tag byte,
  `u64` LE — `decode.ts` matches `events.rs`; `logScope.ts` bracketing handles nested CPIs and same-program re-entry
  (`lastIndexOf` pop); failed txs skipped by `err`. Per-tx log volume from the pool itself (~0.6 KB per event, ≤3 events) is
  far under 10 KB — the risk is external logging (F-4).
- `prover-wasm` (`proveCore.ts`) reuses `@kakure/prover`'s `executeWitness`/`decodePublicWitness`/`compressProof`, so output
  parity with the native path is structural, not re-implemented.

**B/C — privacy and binding**
- `withdraw_multisig` binds `recipient`/`intent_hash` through `msg_withdraw` + `verify_frost_spend`; `processor.rs:693`
  re-derives `recipient_field(destination)` exactly as `recipientField.ts` (sha256 with byte 0 zeroed); `amount` is checked
  against the BE-padded `value` input; `transfer_checked` bounds mint/decimals; nullifier PDA `init` semantics are atomic.
- `deposit` rejects Token-2022 and non-SPL mints; asset collision check; vault must be the pool's ATA.
- Keystore randomness (salt/nonce), file modes, `SolanaAccount` non-serializability, `ViewOnlyAccount` refusing `getStateKey`.
- Coordinator logger disjointness by type (`logSession` cannot carry a timestamp) and the TTL sweep logging only counts.
- Indexer `/notes?from=` and `/compliance` are range/global queries (no per-note leak).
