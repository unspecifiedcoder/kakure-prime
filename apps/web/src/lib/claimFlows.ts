/**
 * The recipient claim page's spend path: find the paid note with the FULL account (the view-only
 * scan `singleKeyScan.ts` does for display has no spend scalar), assemble the single-key
 * `withdraw` witness exactly as `e2e/scenario.test.ts` step 6 does (the reference that is green
 * on main), prove it in the browser (`proverFor(CircuitId.Withdraw)` -> `@kakure/prover-wasm`,
 * never the Helper -- spec §3A), and submit through the connected wallet with a fresh lookup
 * table (a real 17-input withdraw does not fit a legacy transaction).
 *
 * `assembleWithdrawInputs` is pure (no network) and is exercised against the real `withdraw`
 * ACIR in `claimFlows.test.ts`; everything chain-facing is in `withdrawClaimedNote`.
 */
import { Fr } from "@aztec/foundation/fields";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  KeyRepository,
  ScanEngine,
  UtxoRepository,
  httpNotesTransport,
  packParents,
  type EphemeralCounterStore,
  type SolanaAccount,
  type WalletNote,
} from "@kakure/sdk";
import { mintSelfNote } from "@kakure/sdk/unsafe-sim";
import type { Point } from "@kakure/sdk/tss";
import { CircuitId, IndexerWitnessSource, WitnessSourceError, type ProverPort, type MerkleWitnessSource } from "@kakure/sdk/tx";
import {
  TxBuilder,
  poolPda,
  assetPda,
  assetId,
  nullifierPda,
  decodePool,
  indexerTransport,
  recipientField,
  type PoolAccount,
} from "@kakure/sdk/solana";
import { fetchComplianceRing, type ComplianceFallback } from "./complianceRing.js";
import type { ConnectedWallet } from "./wallet.js";
import { tokenProgramForMint } from "../ui/tokens.js";
import { ensureLookupTable, extendLookupTableViaWallet, sendViaWallet } from "./treasuryFlows.js";

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function frToBytes32(f: Fr): Uint8Array {
  return new Uint8Array(f.toBuffer());
}

async function retryOnTransientWitnessMismatch<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof WitnessSourceError) || err.reason !== "ROOT_MISMATCH") throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

/** The full-account scan: every note this account can spend, with its spend scalar and spent
 *  flag (the indexer's nullifier feed marks spent ones). `leafRange` narrows to the claim link's
 *  window. */
export async function findClaimableNotes(
  indexerUrl: string,
  account: SolanaAccount,
  leafRange: { fromLeaf: number; toLeaf: number },
  counters: EphemeralCounterStore,
  fetchFn: typeof fetch = fetch,
  fallback?: ComplianceFallback,
): Promise<{ notes: WalletNote[]; keyRepo: KeyRepository }> {
  const compliance = await fetchComplianceRing(indexerUrl, fetchFn, fallback);
  const utxoRepo = new UtxoRepository();
  const keyRepo = new KeyRepository(account, counters);
  const engine = new ScanEngine(httpNotesTransport(indexerUrl, fetchFn), keyRepo, utxoRepo, compliance);
  await engine.sync(0);
  const notes = utxoRepo
    .getUnspentNotes()
    .filter((n) => n.leafIndex >= leafRange.fromLeaf && n.leafIndex < leafRange.toLeaf)
    .sort((a, b) => a.leafIndex - b.leafIndex);
  return { notes, keyRepo };
}

export interface AssembleWithdrawInputsOptions {
  merkle: MerkleWitnessSource;
  account: SolanaAccount;
  /** The account's key repository (the same one the scan used): its `nextSelfEphemeral()` rolls
   *  the change note's ephemeral to an even-y index, which the circuit requires
   *  (`mint_self_note`'s "self discovery tag must be even-y"). Scenario step 6's fixed index 0
   *  only passes when that index happens to land even-y for the recipient's key. */
  keyRepo: KeyRepository;
  note: WalletNote;
  compliancePk: Point;
  /** `recipientField(destinationTokenAccount)` -- the 32-byte field the circuit binds the payout to. */
  recipientField32: Uint8Array;
}

/** The exact `InputMap` `e2e/scenario.test.ts` step 6 proves with (withdraw the WHOLE note;
 *  change = 0, bound to the consumed input via `packParents`). Pure -- proved in-circuit by
 *  `claimFlows.test.ts`. */
export async function assembleWithdrawInputs(opts: AssembleWithdrawInputsOptions): Promise<{
  inputs: Record<string, unknown>;
  amount: bigint;
}> {
  const { note, account, compliancePk } = opts;
  const w = await retryOnTransientWitnessMismatch(() => opts.merkle.witnessFor(note.commitment));
  if (w.leafIndex !== note.leafIndex) {
    throw new Error(`withdraw: merkle source placed the note at index ${w.leafIndex}, scanner has ${note.leafIndex}`);
  }
  const amount = note.note.value;
  const changeEph = (await opts.keyRepo.nextSelfEphemeral()).eph;
  const selfSpendScalar = await account.getSelfSpendKey();
  // The change note's `parents` MUST bind to the consumed input (`assert_parents_bound(change_note,
  // [old_note_index, 0])` in circuits/standard/withdraw) -- the scenario's own hard-won note.
  const change = await mintSelfNote(
    changeEph,
    0n,
    selfSpendScalar,
    note.note.assetId,
    compliancePk,
    packParents([{ leafIndex: w.leafIndex }, { leafIndex: 0 }]),
  );

  const inputs = {
    withdraw_value: amount.toString(),
    recipient: bytesToBigIntBE(opts.recipientField32).toString(),
    intent_hash: "0",
    compliance_pubkey_x: "0x" + compliancePk[0].toString(16),
    compliance_pubkey_y: "0x" + compliancePk[1].toString(16),
    old_note: {
      note_version: note.note.noteVersion.toString(),
      asset_id: note.note.assetId.toString(),
      note_type: note.note.noteType.toString(),
      conditions_hash: note.note.conditionsHash.toString(),
      value: note.note.value.toString(),
      owner: note.note.owner.toString(),
      psi: note.note.psi.toString(),
      parents: note.note.parents.toString(),
    },
    spend_scalar: note.spendScalar.toString(),
    old_note_index: w.leafIndex.toString(),
    old_note_path: w.siblings.map((f) => f.toString()),
    change_note: {
      note_version: change.note.noteVersion.toString(),
      asset_id: change.note.assetId.toString(),
      note_type: change.note.noteType.toString(),
      conditions_hash: change.note.conditionsHash.toString(),
      value: change.note.value.toString(),
      owner: change.note.owner.toString(),
      psi: change.note.psi.toString(),
      parents: change.note.parents.toString(),
    },
    change_eph: changeEph.toString(),
  };
  return { inputs, amount };
}

export interface WithdrawClaimedNoteOptions {
  connection: Connection;
  wallet: ConnectedWallet;
  account: SolanaAccount;
  keyRepo: KeyRepository;
  programId: PublicKey;
  mint: PublicKey;
  indexerUrl: string;
  note: WalletNote;
  proverPort: ProverPort;
  onStage?: (stage: "assembling" | "proving" | "submitting") => void;
}

async function currentPool(connection: Connection, poolAddress: PublicKey): Promise<PoolAccount> {
  const acct = await connection.getAccountInfo(poolAddress);
  if (!acct) throw new Error(`pool account ${poolAddress.toBase58()} not found`);
  return decodePool(acct.data);
}

/**
 * Withdraws `note` in full to the connected wallet's token account for `mint`. Steps mirror
 * scenario step 6: witness -> real withdraw proof (browser wasm) -> `TxBuilder.withdraw` ->
 * v0 transaction over a wallet-created lookup table.
 */
export async function withdrawClaimedNote(opts: WithdrawClaimedNoteOptions): Promise<{ signature: string; amount: bigint }> {
  const { connection, wallet, account, programId, mint, indexerUrl, note, proverPort } = opts;
  opts.onStage?.("assembling");

  const [poolAddress] = poolPda(programId);
  const pool = await currentPool(connection, poolAddress);
  const compliancePk: Point = [bytesToBigIntBE(pool.compliancePkX), bytesToBigIntBE(pool.compliancePkY)];
  const assetIdBytes = assetId(mint);
  if (bytesToBigIntBE(assetIdBytes) !== note.note.assetId.toBigInt()) {
    throw new Error("this payment is not in the asset the claim link names");
  }
  const [assetAddress] = assetPda(programId, assetIdBytes);
  const tokenProgram = await tokenProgramForMint(connection, mint);
  const vault = await getAssociatedTokenAddress(mint, poolAddress, true, tokenProgram);
  const destination = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgram);

  const merkle = new IndexerWitnessSource(indexerTransport(indexerUrl, () => note.leafIndex));
  const { inputs, amount } = await assembleWithdrawInputs({
    merkle,
    account,
    keyRepo: opts.keyRepo,
    note,
    compliancePk,
    recipientField32: recipientField(destination),
  });

  opts.onStage?.("proving");
  const bundle = await proverPort.prove(CircuitId.Withdraw, inputs);

  opts.onStage?.("submitting");
  const verifierProgram = pool.verifiers[CircuitId.Withdraw];
  if (!verifierProgram) throw new Error("pool has no withdraw verifier registered");
  const nullifierAddr = nullifierPda(programId, frToBytes32(note.nullifier))[0];

  // Destination token account first (its own small legacy-size tx), so the proof tx stays minimal.
  const alt = await ensureLookupTable(connection, wallet);
  await sendViaWallet(
    connection,
    wallet,
    [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, destination, wallet.publicKey, mint, tokenProgram)],
    alt,
  );
  await extendLookupTableViaWallet(connection, wallet, alt, [
    programId,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    verifierProgram,
    poolAddress,
    assetAddress,
    mint,
    vault,
    nullifierAddr,
    destination,
  ]);

  const poolNow = await currentPool(connection, poolAddress);
  const ixs = new TxBuilder(programId).withdraw(
    bundle,
    amount,
    {
      pool: poolAddress,
      asset: assetAddress,
      mint,
      nullifier: nullifierAddr,
      vault,
      destinationTokenAccount: destination,
      payer: wallet.publicKey,
      verifierProgram,
      tokenProgram,
    },
    poolNow,
  );
  const signature = await sendViaWallet(connection, wallet, ixs, alt);
  return { signature, amount };
}
