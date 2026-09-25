import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle } from "../tx/ports.js";
import { BorshWriter } from "./borsh.js";
import { poolPda } from "./pda.js";
import { rootIndexFor, type PoolAccount } from "./poolAccounts.js";

/**
 * Compressed proof wire size (workstream G): `A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ pok(32)`.
 * `ProofBundle.proof` must already be exactly this many bytes by the time it reaches `TxBuilder`
 * (`@kakure/prover`'s `prove()` compresses it -- see `tx/ports.ts`'s `ProofBundle` doc comment for
 * why the compression itself does not live here).
 */
const COMPRESSED_PROOF_LEN = 192;

/**
 * Workstream G: `PoolInstruction::{Transfer,TransferMultisig,SplitMultisig,JoinMultisig,Withdraw,
 * WithdrawMultisig}`'s `public_inputs` no longer carries `cpk_x`/`cpk_y` (nor, for spends, `root`)
 * -- the pool injects its own compliance key and the resolved root at these exact ORIGINAL I-1
 * positions before the verifier CPI (`processor.rs`). `stripIndices` (ascending) are the positions
 * to remove from a `ProofBundle`'s full I-1 `publicInputs` to get the wire-format array;
 * `rootIndexAt`, if present, is where `root` sits in the FULL array (used to look up `root_index`
 * before stripping).
 */
interface PublicInputLayout {
  readonly stripIndices: readonly number[];
  readonly rootIndexAt?: number;
}

const LAYOUT: Readonly<Record<CircuitId, PublicInputLayout>> = {
  // [cpk_x, cpk_y, leaf, eph_pub_x, value, asset_id, ct0..6] -- no root.
  [CircuitId.Deposit]: { stripIndices: [0, 1] },
  // [cpk_x, cpk_y, nullifier, root, memo_leaf, ..., change_ct6].
  [CircuitId.Transfer]: { stripIndices: [0, 1, 3], rootIndexAt: 3 },
  [CircuitId.TransferMultisig]: { stripIndices: [0, 1, 3], rootIndexAt: 3 },
  // [cpk_x, cpk_y, nullifier, root, out1_leaf, ..., out2_ct6].
  [CircuitId.SplitMultisig]: { stripIndices: [0, 1, 3], rootIndexAt: 3 },
  // [cpk_x, cpk_y, nullifier_a, nullifier_b, root, out_leaf, ..., out_ct6].
  [CircuitId.JoinMultisig]: { stripIndices: [0, 1, 4], rootIndexAt: 4 },
  // [value, recipient, intent_hash, cpk_x, cpk_y, nullifier, root, asset_id, ..., change_ct6].
  [CircuitId.Withdraw]: { stripIndices: [3, 4, 6], rootIndexAt: 6 },
  [CircuitId.WithdrawMultisig]: { stripIndices: [3, 4, 6], rootIndexAt: 6 },
};

/** Thrown by a spend builder when `bundle`'s root (per `LAYOUT`) is not present in `pool`'s
 *  256-entry ring buffer -- i.e. `rootIndexFor` returned `undefined`. */
export class RootNotInRingError extends Error {
  constructor(circuitId: CircuitId) {
    super(
      `TxBuilder: the root in this ${CircuitId[circuitId]} proof's public inputs is not in the pool's root ring -- it has likely been overwritten (the ring holds only the last 256 roots) or the proof was built against a different pool/cluster. Re-scan and re-prove against a current root.`,
    );
    this.name = "RootNotInRingError";
  }
}

/** Strips `cpk_x`/`cpk_y` (and, for spends, `root`) out of `bundle.publicInputs` per `LAYOUT`,
 *  returning the shorter wire-format array `PoolInstruction`'s variants now carry. */
function wirePublicInputs(bundle: ProofBundle): Uint8Array[] {
  const remove = new Set(LAYOUT[bundle.circuitId].stripIndices);
  return bundle.publicInputs.filter((_, i) => !remove.has(i)) as Uint8Array[];
}

/** Resolves the `root_index` a spend instruction must carry from `bundle`'s full public inputs
 *  and `pool`'s root ring. Throws `RootNotInRingError` if the root is not (or no longer) present. */
function resolveRootIndex(bundle: ProofBundle, pool: PoolAccount): number {
  const rootIndexAt = LAYOUT[bundle.circuitId].rootIndexAt;
  if (rootIndexAt === undefined) {
    throw new Error(`TxBuilder: circuit ${bundle.circuitId} has no root (deposit) -- resolveRootIndex should not be called for it`);
  }
  const root = bundle.publicInputs[rootIndexAt];
  if (!root) {
    throw new Error(`TxBuilder: bundle.publicInputs[${rootIndexAt}] (root) is missing`);
  }
  const idx = rootIndexFor(pool, root);
  if (idx === undefined) throw new RootNotInRingError(bundle.circuitId);
  return idx;
}

// Hardcoded rather than depending on `@solana/spl-token` (`@solana/web3.js` itself does not export
// these), mirroring `programs/kakure_pool/src/ata.rs`'s own hardcoded `ASSOCIATED_TOKEN_PROGRAM_ID`.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * Builds every `kakure_pool` instruction (I-3) from a `ProofBundle` (I-6), matching B's native
 * `solana-program` wire format exactly:
 *   - `programs/kakure_pool/src/instruction.rs`: instruction data = `borsh::to_vec(&PoolInstruction)`
 *     -- one leading `u8` variant tag (0-based declaration order below) + borsh(fields). This is
 *     NOT Anchor's 8-byte sighash discriminator, so `@coral-xyz/anchor`'s `BorshInstructionCoder`
 *     cannot be used here; see `./borsh.ts`.
 *   - `programs/kakure_pool/src/processor.rs`: exact account order per instruction, reproduced
 *     1:1 in each method below (see the per-method doc comment for the accounts.rs function it
 *     mirrors).
 *   - Every instruction that CPIs a verifier passes that verifier program as the FIRST account
 *     after the instruction's own fixed accounts (`verify.rs`'s `verify_cpi`); the pool checks it
 *     equals `pool.verifiers[circuit_id]` before the CPI, but a FAILING CPI aborts the whole
 *     transaction with the CALLEE's (verifier's) own error -- Solana's runtime never returns
 *     control to the caller on a failed `invoke()`, so `verify_cpi` cannot catch and rewrite it to
 *     `PoolError::InvalidProof` (slice-2 F-6; the old `map_err` there was dead code, removed).
 *     Decode a verifier CPI failure with `@kakure/sdk/solana`'s `decodePoolError(err, logs)`,
 *     which reports it as `InvalidProof` / `VerifierError(<GnarkError name>)` rather than
 *     misattributing the verifier's raw `Custom(n)` to an unrelated `PoolError`.
 *
 * A `ComputeBudgetProgram.setComputeUnitLimit` instruction is prepended to every built instruction
 * set per spec §4 (verifier CPI + up to two leaf inserts can exceed the default 200k-CU limit).
 *
 * Deviation tracked here, not yet landed in `programs/kakure_pool` as of this port: `initialize`
 * is being changed to take a client-computed `genesis_leaf: [u8;32]` (via `solana/genesis.ts`'s
 * `genesisLeaf`, Poseidon2) instead of computing one on-chain. This builder already emits that
 * argument, appended after `verifiers` (position not yet confirmed against the landed Rust --
 * flagged in the workstream report).
 */
export const KAKURE_COMPUTE_UNIT_LIMIT = 1_400_000;

function computeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({
    units: KAKURE_COMPUTE_UNIT_LIMIT,
  });
}

function assertPublicInputs(bundle: ProofBundle): readonly Uint8Array[] {
  const expected = PUBLIC_INPUT_COUNT[bundle.circuitId];
  if (bundle.publicInputs.length !== expected) {
    throw new Error(
      `TxBuilder: circuit ${bundle.circuitId} expects ${expected} public inputs (I-1), got ${bundle.publicInputs.length}`,
    );
  }
  for (const word of bundle.publicInputs) {
    if (word.length !== 32) {
      throw new Error(
        `TxBuilder: each public input must be 32 bytes big-endian, got ${word.length}`,
      );
    }
  }
  return bundle.publicInputs;
}

function assertCompressedProof(bundle: ProofBundle): Uint8Array {
  if (bundle.proof.length !== COMPRESSED_PROOF_LEN) {
    throw new Error(
      `TxBuilder: circuit ${bundle.circuitId} expects a ${COMPRESSED_PROOF_LEN}-byte compressed proof (workstream G), got ${bundle.proof.length}. Did this ProofBundle come from @kakure/prover's prove()?`,
    );
  }
  return bundle.proof;
}

/** Writes `proof` (fixed `[u8; 192]`, no length prefix) followed by the WIRE-format
 *  `public_inputs` (`Vec<[u8;32]>`, cpk/root already stripped per `LAYOUT`). Used by `deposit`,
 *  which has no root to inject. */
function writeProofAndWireInputs(w: BorshWriter, bundle: ProofBundle): BorshWriter {
  assertPublicInputs(bundle);
  return w.bytes(assertCompressedProof(bundle)).vecFixed32(wirePublicInputs(bundle));
}


/** 0-based declaration order in `PoolInstruction` (instruction.rs) -- the borsh variant tag. */
enum IxTag {
  Initialize = 0,
  SetVerifier = 1,
  RotateComplianceKey = 2,
  SetPaused = 3,
  Deposit = 4,
  Transfer = 5,
  TransferMultisig = 6,
  SplitMultisig = 7,
  JoinMultisig = 8,
  Withdraw = 9,
  WithdrawMultisig = 10,
}

export interface InitializeAccounts {
  authority: PublicKey;
  /** F9 fix: the program's `ProgramData` account (see `programDataAddress` in `./pda.ts`); the
   *  processor requires `authority` to equal `ProgramData.upgrade_authority_address`. */
  programData: PublicKey;
}

export interface DepositAccounts {
  pool: PublicKey;
  asset: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  depositorTokenAccount: PublicKey;
  depositor: PublicKey;
  verifierProgram: PublicKey;
  tokenProgram?: PublicKey;
  associatedTokenProgram?: PublicKey;
}

export interface SpendAccounts {
  pool: PublicKey;
  nullifier: PublicKey;
  payer: PublicKey;
  verifierProgram: PublicKey;
}

export interface JoinMultisigAccounts {
  pool: PublicKey;
  nullifierA: PublicKey;
  nullifierB: PublicKey;
  payer: PublicKey;
  verifierProgram: PublicKey;
}

export interface WithdrawAccounts {
  pool: PublicKey;
  asset: PublicKey;
  mint: PublicKey;
  nullifier: PublicKey;
  vault: PublicKey;
  destinationTokenAccount: PublicKey;
  payer: PublicKey;
  verifierProgram: PublicKey;
  tokenProgram?: PublicKey;
}

export class TxBuilder {
  constructor(private readonly programId: PublicKey) {}

  poolAddress(): PublicKey {
    return poolPda(this.programId)[0];
  }

  private ix(data: BorshWriter, keys: AccountMeta[]): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: data.toBuffer(),
    });
  }

  /** Mirrors `processor.rs::initialize`: authority(signer,payer,w), pool(w), program_data(r,
   *  F9 fix -- must be the program's real ProgramData account so the processor can check
   *  `authority == ProgramData.upgrade_authority_address`), system_program. */
  initialize(
    args: {
      compliancePkX: Uint8Array;
      compliancePkY: Uint8Array;
      verifiers: readonly PublicKey[];
      genesisLeaf: Uint8Array;
    },
    accounts: InitializeAccounts,
  ): TransactionInstruction[] {
    if (args.compliancePkX.length !== 32 || args.compliancePkY.length !== 32) {
      throw new Error("TxBuilder.initialize: compliancePkX/compliancePkY must be 32 bytes");
    }
    if (args.verifiers.length !== 7) {
      throw new Error("TxBuilder.initialize: expects exactly 7 verifier programs (I-1)");
    }
    if (args.genesisLeaf.length !== 32) {
      throw new Error("TxBuilder.initialize: genesisLeaf must be 32 bytes");
    }
    const w = new BorshWriter()
      .u8(IxTag.Initialize)
      .bytes(args.compliancePkX)
      .bytes(args.compliancePkY);
    for (const v of args.verifiers) w.pubkey(v);
    // Not yet landed in programs/kakure_pool -- see class doc comment.
    w.bytes(args.genesisLeaf);

    const ix = this.ix(w, [
      { pubkey: accounts.authority, isSigner: true, isWritable: true },
      { pubkey: this.poolAddress(), isSigner: false, isWritable: true },
      { pubkey: accounts.programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    return [computeBudgetIx(), ix];
  }

  /** Mirrors `processor.rs::set_verifier`: authority(signer), pool(w). */
  setVerifier(
    circuitId: CircuitId,
    verifierProgram: PublicKey,
    accounts: { pool: PublicKey; authority: PublicKey },
  ): TransactionInstruction {
    const w = new BorshWriter().u8(IxTag.SetVerifier).u8(circuitId).pubkey(verifierProgram);
    return this.ix(w, [
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
    ]);
  }

  /** Mirrors `processor.rs::rotate_compliance_key`: authority(signer), pool(w). */
  rotateComplianceKey(
    x: Uint8Array,
    y: Uint8Array,
    accounts: { pool: PublicKey; authority: PublicKey },
  ): TransactionInstruction {
    if (x.length !== 32 || y.length !== 32) {
      throw new Error("TxBuilder.rotateComplianceKey: x/y must be 32 bytes");
    }
    const w = new BorshWriter().u8(IxTag.RotateComplianceKey).bytes(x).bytes(y);
    return this.ix(w, [
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
    ]);
  }

  /** Mirrors `processor.rs::set_paused`: authority(signer), pool(w). */
  setPaused(
    paused: boolean,
    accounts: { pool: PublicKey; authority: PublicKey },
  ): TransactionInstruction {
    const w = new BorshWriter().u8(IxTag.SetPaused).bool(paused);
    return this.ix(w, [
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
    ]);
  }

  /**
   * Mirrors `processor.rs::deposit`: depositor(signer,payer,w), pool(w), asset(w), mint,
   * vault(w), depositor_token_account(w), token_program, associated_token_program,
   * system_program, verifier_program (pool.verifiers[0]).
   */
  deposit(bundle: ProofBundle, amount: bigint, accounts: DepositAccounts): TransactionInstruction[] {
    if (bundle.circuitId !== CircuitId.Deposit) {
      throw new Error("TxBuilder.deposit: bundle.circuitId must be CircuitId.Deposit");
    }
    const w = writeProofAndWireInputs(new BorshWriter().u8(IxTag.Deposit), bundle).u64(amount);
    const ix = this.ix(w, [
      { pubkey: accounts.depositor, isSigner: true, isWritable: true },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.asset, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenProgram ?? TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: accounts.associatedTokenProgram ?? ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accounts.verifierProgram, isSigner: false, isWritable: false },
    ]);
    return [computeBudgetIx(), ix];
  }

  /**
   * Mirrors `processor.rs::transfer_like` (shared by `transfer`/`transfer_multisig`/
   * `split_multisig`): payer(signer,w), pool(w), nullifier(w), system_program,
   * verifier_program. `pool` is this instruction's own pool account (decoded via `decodePool`),
   * used ONLY to resolve `bundle`'s root to a `root_index` (workstream G) -- throws
   * `RootNotInRingError` if the root is not (or no longer) in the ring.
   */
  private spendLike(
    tag: IxTag,
    circuitId: CircuitId,
    bundle: ProofBundle,
    accounts: SpendAccounts,
    pool: PoolAccount,
  ): TransactionInstruction[] {
    if (bundle.circuitId !== circuitId) {
      throw new Error(`TxBuilder: bundle.circuitId mismatch for ix tag ${tag}`);
    }
    const rootIndex = resolveRootIndex(bundle, pool);
    const w = writeProofAndWireInputs(new BorshWriter().u8(tag), bundle).u8(rootIndex);
    const ix = this.ix(w, [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accounts.verifierProgram, isSigner: false, isWritable: false },
    ]);
    return [computeBudgetIx(), ix];
  }

  transfer(bundle: ProofBundle, accounts: SpendAccounts, pool: PoolAccount): TransactionInstruction[] {
    return this.spendLike(IxTag.Transfer, CircuitId.Transfer, bundle, accounts, pool);
  }

  transferMultisig(bundle: ProofBundle, accounts: SpendAccounts, pool: PoolAccount): TransactionInstruction[] {
    return this.spendLike(IxTag.TransferMultisig, CircuitId.TransferMultisig, bundle, accounts, pool);
  }

  splitMultisig(bundle: ProofBundle, accounts: SpendAccounts, pool: PoolAccount): TransactionInstruction[] {
    return this.spendLike(IxTag.SplitMultisig, CircuitId.SplitMultisig, bundle, accounts, pool);
  }

  /**
   * Mirrors `processor.rs::join_multisig`: payer(signer,w), pool(w), nullifier_a(w),
   * nullifier_b(w), system_program, verifier_program (pool.verifiers[5]). `pool` is used ONLY to
   * resolve a `root_index` -- see `spendLike`'s doc comment.
   */
  joinMultisig(
    bundle: ProofBundle,
    accounts: JoinMultisigAccounts,
    pool: PoolAccount,
  ): TransactionInstruction[] {
    if (bundle.circuitId !== CircuitId.JoinMultisig) {
      throw new Error("TxBuilder.joinMultisig: bundle.circuitId must be CircuitId.JoinMultisig");
    }
    const rootIndex = resolveRootIndex(bundle, pool);
    const w = writeProofAndWireInputs(new BorshWriter().u8(IxTag.JoinMultisig), bundle).u8(rootIndex);
    const ix = this.ix(w, [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifierA, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifierB, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accounts.verifierProgram, isSigner: false, isWritable: false },
    ]);
    return [computeBudgetIx(), ix];
  }

  /**
   * Mirrors `processor.rs::withdraw_like` (shared by `withdraw`/`withdraw_multisig`):
   * payer(signer,w), pool(w), nullifier(w), asset(r), mint, vault(w),
   * destination_token_account(w), token_program, system_program, verifier_program. `pool` is used
   * ONLY to resolve a `root_index` -- see `spendLike`'s doc comment. Wire field order is
   * `proof, public_inputs, amount, root_index` (`PoolInstruction::Withdraw`'s declaration order --
   * `root_index` comes AFTER `amount`, unlike the other spend ixs, which have no `amount` field).
   */
  private withdrawLike(
    tag: IxTag,
    circuitId: CircuitId,
    bundle: ProofBundle,
    amount: bigint,
    accounts: WithdrawAccounts,
    pool: PoolAccount,
  ): TransactionInstruction[] {
    if (bundle.circuitId !== circuitId) {
      throw new Error(`TxBuilder: bundle.circuitId mismatch for ix tag ${tag}`);
    }
    const rootIndex = resolveRootIndex(bundle, pool);
    const w = writeProofAndWireInputs(new BorshWriter().u8(tag), bundle).u64(amount).u8(rootIndex);
    const ix = this.ix(w, [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier, isSigner: false, isWritable: true },
      { pubkey: accounts.asset, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenProgram ?? TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accounts.verifierProgram, isSigner: false, isWritable: false },
    ]);
    return [computeBudgetIx(), ix];
  }

  withdraw(
    bundle: ProofBundle,
    amount: bigint,
    accounts: WithdrawAccounts,
    pool: PoolAccount,
  ): TransactionInstruction[] {
    return this.withdrawLike(IxTag.Withdraw, CircuitId.Withdraw, bundle, amount, accounts, pool);
  }

  withdrawMultisig(
    bundle: ProofBundle,
    amount: bigint,
    accounts: WithdrawAccounts,
    pool: PoolAccount,
  ): TransactionInstruction[] {
    return this.withdrawLike(
      IxTag.WithdrawMultisig,
      CircuitId.WithdrawMultisig,
      bundle,
      amount,
      accounts,
      pool,
    );
  }
}
