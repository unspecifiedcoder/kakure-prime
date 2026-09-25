# Review slice 1 — findings (money path + circuit diff + hard limits)

Reviewed at `141e560`. Read-only review; evidence gathered with `cargo test --lib`
(kakure_pool), `~/.nargo/bin/nargo test` on single crates, `sunspot verify` on copies of
`circuits/target/withdraw.*`, a keccak recomputation of `domains.nr`, and a parser over the
gnark `.vk` files. Legend: **verified** = demonstrated by a test/computation in this review;
**plausible** = deterministic from the code but not executed here (litesvm tests need
`cargo build-sbf`, which this review did not run).

Note: the `nargo` on `PATH` is `1.0.0-beta.19`; only `~/.nargo/bin/nargo` is the pinned
`beta.22`. `nargo test` with the PATH binary fails to compile `shared` (`to_le_bits` generic).
Every Noir command below must use `~/.nargo/bin/nargo`.

---

## F1 — CRITICAL — single-key `withdraw` proof does not bind `recipient` or `intent_hash` (verified)

**Where.** `circuits/standard/withdraw/src/main.nr:10-11` (`_recipient: pub Field`,
`_intent_hash: pub Field`, never read). On-chain the pool relies on the proof to bind these:
`programs/kakure_pool/src/processor.rs:685-695` only checks `recipient == recipient_field(destination)`
and `intent_hash == 0`, both of which an attacker can satisfy for *their own* destination.

**Why it matters.** In Groth16 a public input that appears in no constraint has a zero
`(β·A_i+α·B_i+C_i)/γ` element in the VK, so the verifier ignores it. This is not the case in
UltraHonk (the reference EVM system hashes all public inputs into the transcript), so the
spec's "binds it only on-chain (same as the reference EVM implementation)" (§3.3) does not
carry over to Groth16/Sunspot.

**Evidence.**
1. `sunspot verify withdraw.vk withdraw.proof <pw>` on the shipped KAT artifacts:
   - original `.pw` → `Verification successful`
   - `.pw` with byte 31 of public input 1 (`recipient`) XOR `0x55` **and** input 2
     (`intent_hash`) XOR `0x01` → `Verification successful` ← **the same proof accepts a
     different recipient**
   - control: input 0 (`withdraw_value`) XOR `0x01` → `pairing doesn't match`
   - control: input 5 (`nullifier`) XOR `0x01` → `pairing doesn't match`
2. Parsing every `circuits/target/*.vk` (gnark raw layout: α(64) β₁(64) β₂(128) γ₂(128)
   δ₁(64) δ₂(128), then `u32 nK` + nK×64-byte K elements; K[0] is the constant wire, K[i+1] is
   public input i; all-zero = point at infinity): `withdraw.vk` has infinity K elements for
   **public inputs 1 and 2 only**; deposit, transfer, transfer_multisig, split_multisig,
   join_multisig and withdraw_multisig have none (withdraw_multisig binds recipient through
   `msg_withdraw` → `verify_frost_spend`).

**Failure scenario.** Alice builds a valid single-key `Withdraw` for 400 000 tokens to her token
account `D_A`. Anyone who sees the transaction before it lands (the RPC she submits to, the
leader, a relayer she uses) rebuilds it with `destination = D_M` (Mallory's account), public
input `[1] = recipient_field(D_M)`, same proof, same `root_index`, same nullifier, and submits
it first. `withdraw_like` passes every check (`recipient == recipient_field(D_M)`, proof
verifies), creates Alice's nullifier PDA and pays Mallory. Alice's note is spent; her retry
fails with `NullifierSpent`.

**Fix (exact).**
1. `circuits/standard/withdraw/src/main.nr`: rename the params to `recipient` / `intent_hash`
   and add, immediately after the `compliance_pk` line (currently line 22):
   ```noir
   // Groth16 ignores unconstrained public inputs; force both into the constraint system.
   // recipient_field zeroes its top byte (< 2^248) and intent_hash must be 0 in v1.
   recipient.assert_max_bit_size::<248>();
   intent_hash.assert_max_bit_size::<248>();
   ```
   If (only if) the VK check in step 4 still shows an infinity element after rebuilding, use
   instead: `let _bind = poseidon::poseidon2::Poseidon2::hash([recipient, intent_hash], 2); assert(_bind != 0);`.
   No KAT value changes (no output depends on these inputs); `~/.nargo/bin/nargo test --package withdraw`
   must still report `30 tests passed`.
2. Rebuild: `just build-circuits` (regenerates `withdraw.{json,ccs,pk,vk,so}` and
   `circuits/manifest.json`; the manifest drift test will otherwise fail on `vk_sha256`).
   Re-run `just verify-kat`'s prove/verify for `withdraw` so `withdraw.proof/.pw` match the
   new key (the e2e withdraw KAT in `packages/prover` also re-proves).
3. Add the failing test **now** (red before the fix, green after) to `circuits/manifest.test.ts`
   (vitest, already wired to `pnpm test` in `circuits/`):
   ```ts
   import { readFileSync, existsSync } from "node:fs";
   import { join } from "node:path";
   import { describe, it, expect } from "vitest";

   const NAMES = ["deposit","transfer","withdraw","transfer_multisig","split_multisig","join_multisig","withdraw_multisig"];
   const RAW_HEADER = 64 + 64 + 128 + 128 + 64 + 128; // gnark raw VK: a1 b1 b2 g2 d1 d2

   function infinityPublicInputs(vk: Buffer): number[] {
     const nK = vk.readUInt32BE(RAW_HEADER);
     const out: number[] = [];
     for (let i = 1; i < nK; i++) { // K[0] is the constant-1 wire
       const k = vk.subarray(RAW_HEADER + 4 + 64 * i, RAW_HEADER + 4 + 64 * (i + 1));
       if (k.every((b) => b === 0)) out.push(i - 1);
     }
     return out;
   }

   describe("every Groth16 public input is constrained (VK has no point-at-infinity K element)", () => {
     for (const name of NAMES) {
       it(name, () => {
         const p = join(__dirname, "target", `${name}.vk`);
         if (!existsSync(p)) return; // artifacts absent: skip, never fake
         expect(infinityPublicInputs(readFileSync(p))).toEqual([]);
       });
     }
   });
   ```
   (The last K element is gnark's commitment wire and is never infinity here, so no special
   case is needed; if a future circuit drops the commitment, adjust `nK - 1`.)
4. Add a mutation test in the `justfile` (`verify-kat` block, after the existing
   `sunspot verify`):
   ```bash
   # Tampered recipient (public input 1) MUST fail for withdraw.
   name=withdraw
   python3 - <<'EOF'
   d=bytearray(open('target/withdraw.pw','rb').read()); d[12+32+31]^=0x55
   open('target/withdraw.tampered.pw','wb').write(d)
   EOF
   if (cd target && sunspot verify withdraw.vk withdraw.proof withdraw.tampered.pw); then
     echo "withdraw proof does not bind recipient"; exit 1; fi
   ```
5. Fix the spec text (§3.3) and `circuits/README.md`: single-key withdraw's recipient is bound
   **in the proof statement** (constrained public input), not only on-chain.

**Acceptance.** `cd circuits && pnpm test` green (new VK test included); `just verify-kat` exits
non-zero on the tampered `.pw` step before the fix and zero after; `~/.nargo/bin/nargo test --package withdraw` → 30 passed.

---

## F2 — CRITICAL — `deposit` never validates `token_program` (or the ATA program); a fake token program mints unbacked notes that drain the real vault (plausible; deterministic from code)

**Where.** `programs/kakure_pool/src/processor.rs:302` reads `token_program_ai`; it is used
unchecked at `:367` (vault derivation), `:392-407` (ATA create CPI) and `:414-432`
(`transfer_checked` CPI). The only token-program check is on the **mint owner** (`:320-325`).
`ata_program_ai` (`:303`) is also unchecked (harmless by itself: `invoke` resolves the hardcoded
ATA id, but keep the check for clarity). `withdraw_like` (`:661`, `:744`) has the same gap
(self-harm only there: the real vault can only be moved by the real token program).

**Why it is exploitable.** With `token_program = Evil` (an attacker program that returns `Ok`
for `TransferChecked`, `InitializeImmutableOwner`, `InitializeAccount3`, and sets return data
for `GetAccountDataSize`):
- `expected_vault = ATA(pool, mint, Evil)` — attacker passes exactly that address.
- The real ATA program (`spl-associated-token-account` 8.0.0, `processor.rs:78`) takes the
  token program **from the account list without validation** and creates the PDA owned by
  `Evil`, CPI-ing `Evil` for size/initialisation. (Verified by reading the vendored crate source.)
- `transfer_checked` is CPI'd into `Evil` → no tokens move.
- `merkle::insert` inserts a leaf whose public `value = amount` for the **real** mint
  (`asset_id_field(mint)` is derived from the real mint; the `Asset` PDA else-branch at
  `:382-388` checks only `asset.mint`, not `asset.vault`).
- Attacker then submits a genuine `withdraw`/`withdraw_multisig` proof for that note with the
  **real** token program and the **real** vault (`asset.vault()`), draining honest deposits.

**Failure scenario.** Pool holds 1 000 000 USDC-like tokens from honest deposits. Mallory
deposits `amount = 1 000 000` via `Evil`, paying nothing; obtains a valid note; withdraws
1 000 000 from the real vault. Repeat until empty.

**Fix (exact).**
1. `processor.rs` `deposit`, right after the `is_signer` check (`:308-310`), add:
   ```rust
   if token_program_ai.key != &spl_token::ID {
       return Err(PoolError::UnsupportedMint.into());
   }
   if ata_program_ai.key != &crate::ata::ASSOCIATED_TOKEN_PROGRAM_ID {
       return Err(ProgramError::IncorrectProgramId);
   }
   ```
2. `processor.rs` `deposit` else-branch (`:383-387`): after the `asset.mint()` check add
   `if asset.vault() != *vault_ai.key { return Err(ProgramError::InvalidSeeds); }`.
3. `processor.rs` `withdraw_like`, after the `is_signer` check (`:666-668`), add
   `if token_program_ai.key != &spl_token::ID { return Err(ProgramError::IncorrectProgramId); }`.
4. Failing test, `tests-litesvm/tests/pool_tests.rs` (red today: fails inside the ATA CPI with
   the mock's `InvalidInstructionData`; green after: `Custom(12)`):
   ```rust
   #[test]
   fn deposit_wrong_token_program_is_rejected() {
       let (mut svm, payer) = setup();
       do_initialize(&mut svm, &payer);
       let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
       // Any executable that is not spl_token stands in for an attacker "token program".
       let evil_token_program = MOCK_VERIFIER_ID;
       let vault = from_kp(&kakure_pool::ata::get_associated_token_address(
           &to_kp(&pool_key()), &to_kp(&mint), &to_kp(&evil_token_program)));
       let asset_id = asset_id_bytes(&mint);
       let mut accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
       accounts[6] = AccountMeta::new_readonly(evil_token_program, false);
       let err = send(&mut svm, &depositor, &[], accounts, PoolInstruction::Deposit {
           proof: accepting_proof(),
           public_inputs: deposit_inputs(&mint, field_of_u64(1), 500_000),
           amount: 500_000,
       }).unwrap_err();
       assert_custom_error(&err, 12 /* UnsupportedMint */);
   }
   ```
   Add the symmetric `withdraw_wrong_token_program_is_rejected` (expect
   `InstructionError::IncorrectProgramId`).

**Acceptance.** `cargo build-sbf` (both programs) then
`cd tests-litesvm && cargo test --test pool_tests deposit_wrong_token_program_is_rejected withdraw_wrong_token_program_is_rejected`.

---

## F3 — HIGH — PDA "init" is not init-if-needed: 1 lamport pre-funded to a nullifier/asset/pool address permanently bricks it (plausible; deterministic from code)

**Where.** `processor.rs:249-251` (`create_nullifier`: `lamports() > 0 → NullifierSpent`),
`:372-378` (asset PDA: `system_instruction::create_account` fails with `AccountAlreadyInUse`
when the target has lamports), `:87-96` (pool PDA in `initialize`, same).

**Who can exploit it.** The nullifier is `Poseidon2(psi, leaf_index)` with
`psi = Poseidon2(derive_cek(eph, compliance_pk), PSI_DOMAIN)`. For a transfer memo note the
**sender** picks `memo_eph` and therefore knows the recipient's `psi` (fixtures document this:
"must equal note_nullifier::psi(derive_cek(15, compliance_pk))"); `leaf_index` is public in
`NoteInserted`. So the payer of any note, the compliance committee, and anyone holding a view
key can compute the victim's nullifier in advance.

**Failure scenario.** Treasury pays vendor V a 400 000 memo note at leaf 7. Treasury (or its
auditor) sends 1 lamport to `nullifier_pda(H(psi, 7))`. V's `withdraw`/`transfer` now returns
`NullifierSpent` (`:250`) forever; the funds are locked in the vault for everyone, including
the pool. Likewise: 1 lamport to `asset_pda(asset_id(mint))` blocks the first deposit of that
mint forever (`create_account` → `AccountAlreadyInUse`); 1 lamport to the pool PDA before
`initialize` blocks initialization of that program id.

**Fix (exact).** Replace the three `create_account` sites with an init-if-needed helper in
`processor.rs` (system program must be in the account list — it already is for every ix):
```rust
fn create_pda_if_needed<'a>(
    program_id: &Pubkey, payer: &AccountInfo<'a>, target: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>, space: usize, seeds: &[&[u8]],
) -> ProgramResult {
    if target.owner == program_id || !target.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let required = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    if have < required {
        invoke(&system_instruction::transfer(payer.key, target.key, required - have),
               &[payer.clone(), target.clone(), system_program.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(target.key, space as u64),
                  &[target.clone(), system_program.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(target.key, program_id),
                  &[target.clone(), system_program.clone()], &[seeds])?;
    Ok(())
}
```
- `create_nullifier`: replace `:249-257` with
  `if nullifier_ai.owner == program_id { return Err(PoolError::NullifierSpent.into()); }`
  followed by `create_pda_if_needed(program_id, payer, nullifier_ai, system_program, NULLIFIER_LEN, &[NULLIFIER_SEED, nullifier, &[bump]])?;`
  (thread `system_program_ai` into `create_nullifier` from each caller).
- asset PDA (`:372-378`) and pool PDA (`:87-96`): same helper; keep the
  `data_is_empty()` branch condition.

Failing tests (`pool_tests.rs`; red today with `Custom(4)` / a system-program error):
```rust
#[test]
fn transfer_succeeds_when_nullifier_pda_is_prefunded() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let root_index = deposit_once(&mut svm, &payer);
    let nullifier = [13u8; 32];
    svm.airdrop(&nullifier_key(&nullifier), 1).unwrap(); // griefing lamport
    let accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    send(&mut svm, &payer, &[], accounts,
         PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index })
        .expect("a pre-funded nullifier address must not count as spent");
    let acc = svm.get_account(&nullifier_key(&nullifier)).unwrap();
    assert_eq!(acc.owner, KAKURE_POOL_ID);
    assert_eq!(acc.data.len(), 1);
}

#[test]
fn deposit_succeeds_when_asset_pda_is_prefunded() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let (mint, depositor, depositor_ata) = setup_mint_and_depositor(&mut svm, &payer, 1_000_000);
    let vault = spl_associated_token_account::get_associated_token_address(&pool_key(), &mint);
    let asset_id = asset_id_bytes(&mint);
    svm.airdrop(&asset_key(&asset_id), 1).unwrap();
    let accounts = deposit_accounts(&depositor.pubkey(), &mint, &vault, &depositor_ata, &asset_id);
    send(&mut svm, &depositor, &[], accounts, PoolInstruction::Deposit {
        proof: accepting_proof(), public_inputs: deposit_inputs(&mint, field_of_u64(42), 500_000), amount: 500_000,
    }).expect("a pre-funded asset PDA must not block the first deposit");
}
```
Keep `transfer_replayed_nullifier_is_rejected` (still `Custom(4)` because the account is
program-owned after the first spend).

**Acceptance.** `cargo build-sbf`; `cd tests-litesvm && cargo test --test pool_tests` all green.

---

## F4 — MEDIUM — `pool` account address is not checked in `transfer`/`transfer_multisig`/`split_multisig`/`join_multisig` and all admin ixs (verified: no check exists; exploit blocked only by runtime invariants)

**Where.** `processor.rs:158-166` (`load_pool_authority`), `:457-486` (`transfer_like`),
`:523-552` (`split_multisig`), `:587-619` (`join_multisig`). Only `initialize` (`:83-86`) and
`withdraw_like` (`:671-674`) verify `pool_ai.key == pool_pda(program_id)`. `Pool::new` checks
only `len == 9550`.

**Why it is currently not exploitable.** A forged pool needs attacker-chosen bytes in a
9550-byte account owned by `kakure_pool` (impossible: the program never writes such an
account) or owned by another program (then `merkle::insert`'s write fails the tx with
`ExternalAccountDataModified`). Both are runtime invariants, not program checks; a future
refactor that moves the insert, adds a read-only path, or emits before writing would turn this
into a real-nullifier-burn / fake-root path. Fix now, it is one line per handler.

**Fix (exact).** Add to `processor.rs`:
```rust
fn expect_pool_pda(program_id: &Pubkey, pool_ai: &AccountInfo) -> Result<u8, ProgramError> {
    let (expected, bump) = pool_pda(program_id);
    if pool_ai.key != &expected || pool_ai.owner != program_id { return Err(ProgramError::InvalidSeeds); }
    Ok(bump)
}
```
Call it first thing in `transfer_like`, `split_multisig`, `join_multisig` (after `is_signer`),
and pass `program_id` into `load_pool_authority` so `set_verifier`/`rotate_compliance_key`/
`set_paused` call it too. Replace the inline check in `withdraw_like` with the helper.

Failing test (litesvm `set_account` can forge what the chain cannot; red today because the
forged pool is accepted and a real nullifier PDA is created):
```rust
#[test]
fn transfer_rejects_non_pda_pool_account() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    // Forge a program-owned "pool" with an accepting verifier and one nonzero root slot.
    let real = svm.get_account(&pool_key()).unwrap();
    let fake_key = Pubkey::new_unique();
    svm.set_account(fake_key, real.clone()).unwrap();
    let nullifier = [21u8; 32];
    let mut accounts = transfer_accounts(&payer.pubkey(), &nullifier);
    accounts[1] = AccountMeta::new(fake_key, false);
    let err = send(&mut svm, &payer, &[], accounts,
        PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index: 0 })
        .unwrap_err();
    use solana_instruction_error::InstructionError; use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidSeeds)), "{err:?}");
    assert!(svm.get_account(&nullifier_key(&nullifier)).is_none(), "no nullifier may be burned against a fake pool");
}
```
Add the same shape for `SetPaused` with a forged pool (expect `InvalidSeeds`).

**Acceptance.** `cd tests-litesvm && cargo test --test pool_tests transfer_rejects_non_pda_pool_account`.

---

## F5 — MEDIUM — money-path coverage gaps in `tests-litesvm/tests/pool_tests.rs` (verified by reading the suite)

Not exercised anywhere (litesvm or e2e): `SplitMultisig`, `JoinMultisig`,
`WithdrawMultisig`, and `TransferMultisig` *through the pool handler* (only `VerifyOnly` is
used); `Paused` on deposit/split/join/withdraw (only transfer); unauthorized signer on any
admin ix; `VerifierUnset` / wrong verifier account (`IncorrectProgramId`); `AssetCollision`;
second deposit to an existing asset; `InvalidLeaf` (zero leaf); `AssetMismatch` and
`AmountMismatch` on withdraw; ring-buffer wrap (>256 inserts, cursor wrap, slot reuse);
`root_index` pointing at the intermediate root between the two inserts of one transfer;
compliance-key rotation making a prior proof fail (backlog item 2); join with
`nullifier_a == nullifier_b` (must be `NullifierSpent` at the second create — the circuit also
forbids it); `NoteInserted.root` equals `pool.root_at(cursor-1)` after the ix; any CU or
message-size assertion (CU is only `eprintln!`ed).

**Fix (exact).** Add these tests to `pool_tests.rs` (helpers already exist):
```rust
#[test]
fn ring_buffer_wraps_at_256_and_reuses_slot_zero() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer); // slot 0 = genesis root
    let root_index = deposit_once(&mut svm, &payer); // slot 1
    // 128 transfers = 256 inserts -> cursor wraps; slot 0 must now hold a *new* root.
    let genesis_root = { let a = svm.get_account(&pool_key()).unwrap(); let mut d = a.data.clone(); Pool::new(&mut d).unwrap().root_at(0) };
    for i in 0..128u8 {
        let mut nullifier = [0u8; 32]; nullifier[0] = 0xA0; nullifier[1] = i;
        svm.expire_blockhash();
        send(&mut svm, &payer, &[], transfer_accounts(&payer.pubkey(), &nullifier),
             PoolInstruction::Transfer { proof: accepting_proof(), public_inputs: transfer_inputs(nullifier), root_index }).unwrap();
    }
    let a = svm.get_account(&pool_key()).unwrap(); let mut d = a.data.clone(); let pool = Pool::new(&mut d).unwrap();
    assert_eq!(pool.root_cursor(), 2u8.wrapping_add(0)); // 2 + 256 mod 256
    assert_ne!(pool.root_at(0), genesis_root);
    assert_eq!(pool.next_leaf_index(), 2 + 256);
    // genesis slot was overwritten: proving against slot 0 now targets the new root, which the
    // mock verifier cannot distinguish; the real-verifier e2e (step 7a) covers rejection.
}

#[test]
fn admin_ixs_reject_non_authority_signer() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let accounts = vec![AccountMeta::new(mallory.pubkey(), true), AccountMeta::new(pool_key(), false)];
    for ix in [
        PoolInstruction::SetPaused { paused: true },
        PoolInstruction::RotateComplianceKey { x: [7u8; 32], y: [8u8; 32] },
        PoolInstruction::SetVerifier { circuit_id: 0, program: mallory.pubkey_as_kp() },
    ] {
        let err = send(&mut svm, &mallory, &[], accounts.clone(), ix).unwrap_err();
        use solana_instruction_error::InstructionError; use solana_transaction_error::TransactionError;
        assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidAccountData)), "{err:?}");
    }
}
```
(`pubkey_as_kp` = `to_kp(&mallory.pubkey())`.) Plus one happy-path + one `Paused` test each for
`SplitMultisig` (19 inputs, leaves at wire index 1 and 10), `JoinMultisig` (11 inputs, two
nullifier PDAs, leaf at index 2), `WithdrawMultisig` (same shape as `Withdraw`,
`circuit_id 6`), and `join_multisig_same_nullifier_twice_is_rejected` (pass the same PDA as
both nullifier accounts; expect `Custom(4)`). Assert CU: `assert!(cu < 1_400_000)` in every
happy path, and for the real-verifier test `assert!(cu < 700_000)`.

**Acceptance.** `cd tests-litesvm && cargo test --test pool_tests` green with the new tests.

---

## F6 — LOW — `merkle.rs` KAT test uses a machine-specific absolute path and silently skips (verified)

`programs/kakure_pool/src/merkle.rs:101` reads `/mnt/e/github2/kakure/circuits/kat/lean_imt_poseidon_v1.json`.
It passed on this box only because that directory exists here; anywhere else the test prints
`SKIP` and reports `ok`, so the frontier-insert ↔ circomlib ↔ Noir parity is unguarded in CI.

**Fix.** Replace line 101 with
`let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../circuits/kat/lean_imt_poseidon_v1.json");`
and replace the `Err(_) => { eprintln!(...); return; }` arm with
`Err(e) => panic!("KAT file missing: {path}: {e}")`.
**Acceptance.** `cd programs/kakure_pool && cargo test --lib` → 1 passed (and fails when the
file is renamed).

---

## F7 — LOW — stale documentation on compliance-key binding and `InvalidProof` (verified)

- `programs/kakure_pool/src/instruction.rs:41-49` says `ComplianceKeyStale` "is kept … for
  `Deposit`, where it still guards against a stale client". False: `deposit` (`processor.rs:352-356`)
  injects `pool.compliance_pk_x/y` exactly like the spend ixs; nothing constructs
  `ComplianceKeyStale`. Backlog item 2 is confirmed: every proof-carrying ix is bound to the
  *current* key by injection; a proof made under an old key fails **inside the verifier CPI**.
- Backlog item 3 is confirmed by `deposit_invalid_proof_is_rejected`: a verifier rejection
  surfaces as the *verifier program's* error (mock: `InvalidInstructionData`; Sunspot
  `verifier-bin`: its own code), never `PoolError::InvalidProof`; `InvalidProof` (Custom 5) is
  only produced by `decompress_proof`. `verify.rs:108`'s `.map_err(|_| InvalidProof)` is dead.

**Fix.** Rewrite `instruction.rs:41-49` to say deposit is injected too; delete the dead
`map_err` (return `invoke(&ix, &infos)` directly) and say so in `verify.rs`'s module doc;
in `packages/sdk`'s `decodePoolError` docs state: "key rotated between proving and submit →
verifier error, re-prove". Add to `pool_tests.rs`:
`rotate_key_then_old_proof_fails_in_verifier` is not expressible with the mock (it ignores
inputs) — cover it in e2e step list instead (rotate, resubmit `s.transferBundle`, expect a
non-`Custom` instruction error from the verifier program index).

---

## F8 — LOW — committed program binary with no reproducible-build recipe; `dev-verify` exclusion is not enforced (plausible)

`programs/deploy/kakure_pool.so` (162 864 B) is tracked in git (`04c3924`), used by
`e2e/localnet.ts:66`; `justfile` has no `cargo build-sbf` target and CI has no rebuild-and-compare.
`processor.rs:54-59` correctly makes `VerifyOnly` unreachable without the feature, but nothing
proves the shipped `.so` was built without it (`strings` shows no marker either way).

**Fix.** `justfile`: add `build-programs: cargo build-sbf --manifest-path programs/kakure_pool/Cargo.toml -- --locked`
(+ mock) and `build-programs-dev-verify` writing to `target/deploy-dev-verify`; CI job rebuilds
and `sha256sum -c` against `programs/deploy/*.so`. Add to the default litesvm suite:
```rust
#[test]
fn verify_only_is_unreachable_in_release_build() {
    let (mut svm, payer) = setup();
    do_initialize(&mut svm, &payer);
    let accounts = vec![AccountMeta::new_readonly(payer.pubkey(), true), AccountMeta::new_readonly(pool_key(), false), AccountMeta::new_readonly(MOCK_VERIFIER_ID, false)];
    let err = send(&mut svm, &payer, &[], accounts, PoolInstruction::VerifyOnly { circuit_id: 0, proof: accepting_proof(), public_inputs: vec![[0u8; 32]; 13] }).unwrap_err();
    use solana_instruction_error::InstructionError; use solana_transaction_error::TransactionError;
    assert!(matches!(err.err, TransactionError::InstructionError(_, InstructionError::InvalidInstructionData)), "{err:?}");
}
```
Point `common::setup` at `programs/deploy/` (the artifact actually shipped) rather than
`../target/deploy`.

---

## F9 — LOW — `initialize` is first-come (verified by reading `:67-96`)

Any signer that lands `Initialize` first becomes `authority`. Deploy and initialize in one
transaction, or require `authority == ProgramData.upgrade_authority` (pass the ProgramData
account, parse `UpgradeableLoaderState::ProgramData`). Test: initialize with a random signer
→ expect `InvalidAccountData` once the check exists.

---

## F10 — LOW — multisig KAT provenance: `join_multisig` uses a t=1 Schnorr stand-in; generator's join root uses the wrong hash (verified)

- `circuits/multisig/join_multisig/src/main.nr:221-225`: single-signer witness. The other
  three multisig KATs are regenerated by `circuits/scripts/gen_frost_kats.ts` with a real
  3-share FROST aggregate (3-of-3, not 3-of-5). **Circuit-level strength is unchanged** in
  both cases: the circuit sees only `(gpk, R, z)`; a threshold aggregate and a single-key
  Schnorr signature are indistinguishable to `verify_frost_spend`. What is lost is
  TS↔Noir parity for `msg_join`: `packages/sdk/src/__tests__/gen-join-multisig-kat.test.ts`
  asserts its own `(R, z)` (`0x13c1…`, `0x009d…`) which are not the `main.nr` constants.
- `gen_frost_kats.ts:128` computes the join root as `Poseidon.hash([leafA, leafB])`
  (Poseidon2, 2-ary) whereas the tree is now `poseidon_v1([left, right, level])`; its join
  output is therefore wrong under the new tree hash — which is presumably why the Noir
  scratch test was used instead.

**Fix.** In `gen_frost_kats.ts` compute `root` with the SDK's LeanIMT hash (`hash3(leafA, leafB, 0n)`
from `packages/sdk/src/merkle/LeanIMT.ts`), re-run, paste the 3-signer `gpk/R/z/psiOut` into
`join_multisig/src/main.nr` and `Prover.toml`, and make `gen-join-multisig-kat.test.ts` assert
the same `R`/`z`/`m` as `main.nr` (as the other three gen-*-kat tests do). Acceptance:
`~/.nargo/bin/nargo test --package join_multisig` and `pnpm --filter @kakure/sdk test gen-join` both green with identical constants.

Old-domain `psi` literals still present (`0x0981a88f…` in `transfer_multisig/main.nr:94`,
`split_multisig/main.nr:86`, `withdraw_multisig/main.nr:81`, `transfer_multisig/Prover.toml:36`,
`Utxo.test.ts:11`; `0x0b78b93e…` in `transfer_multisig/main.nr:127`) are **intentional and
harmless**: they are *input*-note psi values (a spent note's psi is a free witness; the
CEK↔psi binding is asserted only when minting) or feed `should_fail_with` tests whose
earlier assertion fires first (`transfer_multisig` 55/55 pass under beta.22). `gen_frost_kats.ts`
keeps `OLD_PSI` for exactly this reason.

---

## Part C — hard limits per instruction

Serialized signed-transaction size (bytes), 1 signer, `ComputeBudget::SetComputeUnitLimit`
prepended, borsh data = `tag(1) ‖ proof(192) ‖ u32 len ‖ 32·n ‖ extras`. "v0+ALT" = payer and
per-tx fresh accounts (nullifier PDA(s), destination/depositor token account) static, every
fixed address (programs, pool, asset, mint, vault, system) in the lookup table; "all-in-ALT" =
only the payer static (what the e2e does after extending the table).

| ix | data | v0+ALT | all-in-ALT | legacy (no ALT) | asserted? |
|---|---|---|---|---|---|
| deposit (11) | 557 | 791 | 760 | 1065 | e2e `assertFitsPacketLimit` |
| transfer / transfer_multisig (21) | 870 | 1094 | 1063 | **1213** | transfer_multisig only (e2e) |
| split_multisig (19) | 806 | 1030 | 999 | 1149 | no |
| join_multisig (11) | 550 | 807 | 745 | 926 | no |
| withdraw / withdraw_multisig (14) | 654 | 919 | 857 | 1162 | withdraw only (e2e) |

All fit 1232; legacy `transfer` has 19 bytes of margin, so the SDK's v0+ALT-only policy
(`packages/sdk/src/solana/alt.ts`) must stay mandatory. `packages/sdk/src/__tests__/solana.test.ts`
has no size assertion. Recommended: a pure-SDK vitest that compiles each `TxBuilder` ix into a
v0 message with a synthetic `AddressLookupTableAccount` (no validator) and asserts
`serialize().length <= 1232` for all seven; add `split_multisig`/`join_multisig`/
`withdraw_multisig`/`transfer` to e2e `assertFitsPacketLimit` when those steps exist.

Compute units (measured / derived):
- Real Groth16 CPI incl. on-chain decompression, transfer_multisig (24 inputs): **582 167 CU**
  (`ws-b-program.md:99`, litesvm `real_verifier_accepts_transfer_multisig_kat_proof`).
  Verifier cost scales with public-input count (one G1 MSM term each); deposit (13) ≈ 540k.
- Non-verifier remainder (mock verifier): initialize 8 985; deposit 51 116 first / 37 616 repeat;
  transfer 15 983 (two inserts at shallow indices); withdraw 19 588.
- Insert worst case: 32 `sol_poseidon` hashes × ≈1.1k CU (`61·3² + 542`) ≈ 35k per leaf at a
  deep odd index; two leaves ≈ 70k.
- Worst-case totals: deposit ≈ 630k; transfer/transfer_multisig/split ≈ 590k + 70k + 20k ≈ **680k**;
  join ≈ 590k + 35k + 25k ≈ 650k; withdraw/withdraw_multisig ≈ 590k + 35k + 25k ≈ 650k. All
  under the 1.4M cap with ≥2× margin. **No test asserts CU** (litesvm `eprintln!`s, e2e
  `console.log`s). Add `assert!(cu < 1_400_000)` in litesvm happy paths and
  `expect(computeUnitsConsumed).toBeLessThan(1_000_000)` in e2e steps 3/5/6.
- Account sizes: `Pool` 9 550 B (~0.067 SOL rent), `Asset` 85 B, `Nullifier` 1 B (~0.00089 SOL).
- Log budget (indexer slice): `NoteInserted` borsh = 394 B → ~530 B base64 per event; worst tx
  (2 notes + 1 nullifier + tag strings) ≈ 1.3 KB, well under the 10 KB log limit.

---

## Checked and correct (do not re-audit)

- **Domain constants** (`circuits/shared/src/common/domains.nr`): all seven recomputed
  independently as `keccak256(tag) mod Fr` (pycryptodome) — `ENC`, `PSI`, `SCHNORR`,
  `ACTION_{WITHDRAW,TRANSFER,SPLIT,JOIN}` all match byte-for-byte; pairwise-distinct test present.
- **Tree hash switch** (`lib.nr:27-48`): only `Poseidon2::hash(...,3)` → `hash_3` changed vs
  the reference; canonical-index assert, pass-through on zero sibling, and `to_le_bits`
  32-bit bound unchanged. `kat_lean_imt_poseidon_v1`, `kat_cross_check_hash_3`, and the Rust
  `merkle.rs` KAT (same JSON, produced by circomlibjs) all pass → Noir `hash_3`, circomlib and
  `solana-poseidon` (`Bn254X5`, big-endian) agree; `hash3` argument order `(sibling=left, node=right, level)` matches the circuit.
- **Backlog item 1 (withdraw change-note psi)**: `standard/withdraw` `change_note().psi` is
  proven correct — `test_withdraw_kat` mints it with `change_eph = 8`, and `mint_self_note`
  asserts `psi == psi(derive_cek(eph, cpk))` ("psi not bound to CEK"); 30/30 pass on beta.22.
  Same argument covers every minted-note fixture in transfer/deposit/split/join.
- **Public-input layouts**: Noir ABI order (pub params, then return tuple) for all seven
  circuits matches I-1 and the wire re-layout: deposit 2+11, transfer 2+[nf,root]+20,
  split 2+[nf,root]+18, join 2+[nf_a,nf_b,root]+9, withdraw [value,recipient,intent]+2+[nf,root]+9.
  `processor.rs` injection positions and `ct7` offsets are correct; `TxBuilder.LAYOUT` strip
  indices agree. Circuit ids 0..6 map to the right handlers.
- **Root ring**: `push_root` wraps via `wrapping_add` on `u8`; `root_at` stays inside
  `POOL_LEN`; `resolve_root` rejects only never-written (zero) slots — correct semantics, since
  the root is *injected* from the slot and a proof for an evicted root simply fails to verify.
  The intermediate root between a transfer's two inserts is a legitimate tree state.
- **`next_leaf_index`** bounded at `1 << 32`; `leaf_index + 1` cannot overflow.
- **Zero leaf** rejected in `merkle::insert`, which also gates the genesis leaf.
- **`NoteInserted.root`** is the post-insert root (returned by `insert`); `leaf_index` is
  pre-increment; genesis emits an event (fixed earlier).
- **Amount/asset/recipient binding**: `amount` (u64, BE in bytes 24..32) vs `withdraw_value: pub u128`
  and deposit `value`; `asset_id_field` recomputed from the passed mint (and the proof binds
  `asset_id`, so a fake `Asset` account buys nothing); `intent_hash == 0`; `recipient_field`
  top byte zeroed. `withdraw_multisig` binds recipient/intent in the FROST message (VK confirms).
- **Token-2022** rejected via mint owner (both the explicit id and `!= spl_token::ID`).
- **Vault**: derived as ATA of the pool PDA; withdraw signs with `[POOL_SEED, bump]` and
  checks `asset.vault()`.
- **Borrow scoping**: every `Pool`/`Asset` borrow is dropped before a CPI that touches the
  same account (deposit ATA create, withdraw `transfer_checked`).
- **Decompression**: G1/G2 `Validate::No` in `solana-bn254` yields on-curve points; the
  pairing syscall used by the verifier deserializes with `Validate::Yes`, so an off-subgroup
  `B` fails in the verifier. All-zero → identity is handled; `InvalidProof` returned on failure.
- **`dev-verify`**: `VerifyOnly` → `InvalidInstructionData` without the feature; with it,
  authority signature is required.
- **Pause** gates all five money ixs before any state change; **authority** checked on the
  three admin ixs (`is_signer` + equality).
- **Join**: circuit asserts `nullifier_a != nullifier_b` and `index_a < index_b`; on-chain both
  PDAs are created (second create of the same address fails atomically).
- **Nullifier before insert** ordering and `InvalidPublicInputCount` before any read.
- **Multisig KATs**: transfer/split/withdraw regenerated with a real 3-share FROST aggregate
  and verified by `verify()` in the TS tests; mutation tests carried over (55/55 for
  transfer_multisig on beta.22).
