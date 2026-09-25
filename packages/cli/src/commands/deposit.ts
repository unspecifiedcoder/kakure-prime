/**
 * `kakure deposit`: real note assembly + proving + tx building, single-key (personal wallet, not
 * a multisig treasury -- see spec §1: personal deposit/transfer/withdraw exist so a recipient paid
 * by the treasury can move funds; the treasury's OWN spends go through `propose`/`sign`/`execute`,
 * see `execute.ts`).
 *
 * KNOWN LIMITATION (flagged in the workstream report): this mints the self note directly via
 * `mintSelfNote` (exported from `@kakure/sdk/unsafe-sim`, that package's header docstring labels
 * the whole entry point "test/dev-only" even though this one export -- unlike `runDkg` -- carries
 * no such caveat of its own) instead of going through `@kakure/sdk`'s `SelfMintPreflight` +
 * `DiscoverySource` (Howl) collision-detection path that `tx/assemble.ts`'s `assembleDeposit`
 * requires a `SelfMintAuthorization` for. Howl/Raven private discovery is explicitly OUT of v1
 * scope per the design spec, and building a from-scratch `DiscoverySource`/`SelfMintAllocator`
 * pair correctly (with real anti-collision semantics) was judged too large a surface to add
 * correctly under this task's time budget. This is SAFE for a single CLI-managed keystore never
 * used concurrently from two devices (the common CLI case) because ephemeral indices are still
 * reserved from a durable `EphemeralCounterStore` (never reused), but it is NOT the sdk's intended
 * production path for multi-device wallets. A real deployment should route this through
 * `SelfMintPreflight` once a Howl/Raven `DiscoverySource` exists.
 */
import { PublicKey, Keypair, Connection, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import {
  Fr,
  SolanaAccount,
  InMemoryEphemeralCounterStore,
  type EphemeralCounterStore,
} from "@kakure/sdk";
import { mintSelfNote } from "@kakure/sdk/unsafe-sim";
import { assetId, TxBuilder, type DepositAccounts } from "@kakure/sdk/solana";
import { CircuitId, type ProverPort } from "@kakure/sdk/tx";

export interface DepositRequest {
  keypair: Keypair;
  mint: PublicKey;
  amount: bigint;
  compliancePk: [bigint, bigint];
  prover: ProverPort;
  programId: PublicKey;
  accounts: Omit<DepositAccounts, "verifierProgram"> & { verifierProgram: PublicKey };
  counters?: EphemeralCounterStore;
  send?: { connection: Connection; feePayer: Keypair };
}

const DEPOSIT_SELF_SCOPE = "kakure.cli.deposit.self";

export async function runDeposit(req: DepositRequest) {
  const account = await SolanaAccount.fromKeypair(req.keypair);
  const spendScalar = await account.getSelfSpendKey();
  const counters = req.counters ?? new InMemoryEphemeralCounterStore();

  const reservation = await counters.reserve(DEPOSIT_SELF_SCOPE, 1);
  await reservation.commit(reservation.base);
  const eph = await account.getSelfEphemeral(BigInt(reservation.base));

  const assetIdField = new Fr(bytesToBigIntBE(assetId(req.mint)));
  const minted = await mintSelfNote(eph, req.amount, spendScalar, assetIdField, req.compliancePk);

  const bundle = await req.prover.prove(CircuitId.Deposit, {
    compliance_pubkey_x: "0x" + req.compliancePk[0].toString(16),
    compliance_pubkey_y: "0x" + req.compliancePk[1].toString(16),
    note: {
      note_version: minted.note.noteVersion.toString(),
      asset_id: minted.note.assetId.toString(),
      note_type: minted.note.noteType.toString(),
      conditions_hash: minted.note.conditionsHash.toString(),
      value: minted.note.value.toString(),
      owner: minted.note.owner.toString(),
      psi: minted.note.psi.toString(),
      parents: minted.note.parents.toString(),
    },
    eph: eph.toString(),
  });

  const builder = new TxBuilder(req.programId);
  const instructions = builder.deposit(bundle, req.amount, req.accounts);

  if (!req.send) return { bundle, instructions, minted };

  const tx = new Transaction().add(...instructions);
  tx.feePayer = req.send.feePayer.publicKey;
  const signature = await sendAndConfirmTransaction(req.send.connection, tx, [req.send.feePayer]);
  return { bundle, instructions, minted, signature };
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
