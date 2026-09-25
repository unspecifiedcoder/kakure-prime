/**
 * On-chain orchestration for the treasury app's two primary actions: Fund (deposit) and Pay people
 * (batch transfer_multisig). Both mirror `e2e/scenario.test.ts`'s proven working sequence exactly
 * (steps 3 and 5) with two substitutions: proving goes through a `ProverPort` (the Kakure Helper,
 * not `nativeProverPort` directly -- the browser has no filesystem/`sunspot` access), and
 * transaction signing/sending goes through the connected wallet + a shared ALT (`sendViaWallet`)
 * instead of a funded test `Keypair` + `sendV0`.
 *
 * Recipient addressing (see `receiveAddress.ts`): a payroll row's `recipientAddress` is NOT a raw
 * Solana wallet address -- `mintIncomingNote` needs the recipient's `canonicalIncomingAddress`
 * PUBLIC point, which only the recipient can derive (it comes from their own view key). So a
 * recipient must share that public point once, ahead of being paid (exactly like sharing a bank
 * account number) -- see `receiveAddress.ts`'s encode/decode. `recipientInKey` in
 * `AssembleTransferMultisigRequest` is NOT cryptographically used for an incoming note (traced
 * through `note/mint.ts`'s `finish()`: `spendScalar` is stashed on the return value but never
 * feeds `owner`/`psi`/`commitment`/`tag` for the incoming-note path, and `assembleTransferMultisig`
 * drops it entirely when converting to `NoteInput`) -- so it's fine to pass a placeholder here.
 */
import { Fr } from "@aztec/foundation/fields";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
  type TransactionInstruction as TxIx,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { multisigOwner, multisigDepositEph, type MultisigNoteView } from "@kakure/sdk/frost";
import type { Point } from "@kakure/sdk/tss";
import {
  computePsi,
  computeNullifier,
  deriveCek,
  leaf,
  publicKey,
  isEvenY,
  InMemoryEphemeralCounterStore,
  httpNotesTransport,
  type EphemeralCounterStore,
  type NotesTransport,
} from "@kakure/sdk";
import {
  TxBuilder,
  poolPda,
  assetPda,
  assetId,
  nullifierPda,
  decodePool,
  indexerTransport,
  CircuitId,
  ALT_WARMUP_EXTRA_SLOTS,
  type SharedLookupTable,
  type PoolAccount,
} from "@kakure/sdk/solana";
import type { ProverPort } from "@kakure/sdk/tx";
import { IndexerWitnessSource, WitnessSourceError, type MerkleWitnessSource } from "@kakure/sdk/tx";
import {
  assembleTransferMultisig,
  type AssembledTransferMultisig,
  type ProverLike,
  createTransferMultisigProposal,
  signProposal,
  executeProposal,
  buildTransferMultisigInputsFromProposal,
  aggregatePublicShareAt,
  CoordinatorClient,
  deriveSessionKeyFromGvsDecimal,
} from "@kakure/cli";
import type { ConnectedWallet } from "./wallet.js";
import type { GroupRecord } from "./treasury.js";
import type { PayrollRow } from "./payrollPlan.js";
import type { ReceiveAddress } from "./receiveAddress.js";
import { tokenProgramForMint } from "../ui/tokens.js";

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function frToBytes32(f: Fr): Uint8Array {
  return new Uint8Array(f.toBuffer());
}

/** A memo ephemeral is legitimately random (unlike a self-family ephemeral, which is rolled from a
 *  durable counter) but its public key's `y` MUST be even -- the tag is the point's `x`, which only
 *  identifies the point uniquely when `y` is even (`mint::mint_incoming_note`'s own assertion).
 *  Resample until that holds, exactly as `e2e/scenario.test.ts`'s `randomEvenYScalar` does. */
function randomEvenYScalar(): Fr {
  for (;;) {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    const candidate = new Fr(bytesToBigIntBE(bytes));
    if (isEvenY(publicKey(candidate))) return candidate;
  }
}

async function currentPool(connection: Connection, poolAddress: PublicKey): Promise<PoolAccount> {
  const acct = await connection.getAccountInfo(poolAddress);
  if (!acct) throw new Error(`pool account ${poolAddress.toBase58()} not found`);
  return decodePool(acct.data);
}

export async function sendViaWallet(
  connection: Connection,
  wallet: ConnectedWallet,
  ixs: TransactionInstruction[],
  alt: SharedLookupTable,
): Promise<string> {
  const [{ blockhash }, altAccount] = await Promise.all([connection.getLatestBlockhash(), alt.account(connection)]);
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([altAccount]);
  const tx = new VersionedTransaction(message);
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendTransaction(signed as VersionedTransaction);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export interface DepositToTreasuryOptions {
  connection: Connection;
  wallet: ConnectedWallet;
  programId: PublicKey;
  mint: PublicKey;
  amount: bigint;
  gpk: Point;
  /** `GroupRecord.groupViewKey.v`, parsed to bigint -- the group's shared view secret. */
  groupViewSecret: bigint;
  /** A REAL DKG participant id (`GroupRecord.myId` if the depositor is a signer, or any other
   *  member's id otherwise -- e.g. `GroupRecord.participantIds[0]`). `MultisigScanner` only walks
   *  ephemeral scopes for the member ids it's configured with (`multisigScan.ts`'s `#memberIds`
   *  loop), so a note minted under any OTHER id -- an earlier version of this function hardcoded
   *  `0n` -- is real on-chain but permanently undiscoverable by every signer's scanner. */
  depositorMemberId: bigint;
  proverPort: ProverPort;
  alt: SharedLookupTable;
  /** Persisted across deposits so ephemeral indices never repeat for this group+mint pair. */
  ephemeralCounters?: InMemoryEphemeralCounterStore;
}

/**
 * Deposits `amount` of `mint` into the pool as a note owned by the group (multisig-owned), per
 * `e2e/scenario.test.ts` step 3. The depositor pays from their own connected-wallet token account;
 * the resulting note can only ever be spent by a `threshold`-of-`n` FROST signing session over the
 * group's key -- the depositor gives up sole control the instant this transaction confirms.
 */
export async function depositToTreasury(opts: DepositToTreasuryOptions): Promise<{ signature: string }> {
  const { connection, wallet, programId, mint, amount, gpk, groupViewSecret, depositorMemberId, proverPort, alt } = opts;
  const counters = opts.ephemeralCounters ?? new InMemoryEphemeralCounterStore();

  const [poolAddress] = poolPda(programId);
  const pool = await currentPool(connection, poolAddress);
  const compliancePk: Point = [bytesToBigIntBE(pool.compliancePkX), bytesToBigIntBE(pool.compliancePkY)];

  const assetIdBytes = assetId(mint);
  const [assetAddress] = assetPda(programId, assetIdBytes);
  const tokenProgram = await tokenProgramForMint(connection, mint);
  const vault = await getAssociatedTokenAddress(mint, poolAddress, true, tokenProgram);
  const depositorTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgram);

  const eph = await multisigDepositEph(new Fr(groupViewSecret), depositorMemberId, counters, gpk);
  const owner = new Fr(await multisigOwner(gpk));
  const assetIdField = new Fr(bytesToBigIntBE(assetIdBytes));
  const cek = deriveCek(eph.eph, compliancePk);
  const psi = await computePsi(cek);
  const noteFields = {
    noteVersion: new Fr(1n),
    assetId: assetIdField,
    noteType: new Fr(1n), // NOTE_TYPE_MULTISIG
    conditionsHash: new Fr(0n),
    value: amount,
    owner,
    psi,
    parents: new Fr(0n),
  };
  await leaf(noteFields); // sanity: same computation the indexer's scan will redo independently

  const bundle = await proverPort.prove(CircuitId.Deposit, {
    compliance_pubkey_x: "0x" + compliancePk[0].toString(16),
    compliance_pubkey_y: "0x" + compliancePk[1].toString(16),
    note: {
      note_version: noteFields.noteVersion.toString(),
      asset_id: noteFields.assetId.toString(),
      note_type: noteFields.noteType.toString(),
      conditions_hash: noteFields.conditionsHash.toString(),
      value: noteFields.value.toString(),
      owner: noteFields.owner.toString(),
      psi: noteFields.psi.toString(),
      parents: noteFields.parents.toString(),
    },
    eph: eph.eph.toString(),
  });

  const verifierProgram = pool.verifiers[CircuitId.Deposit];
  if (!verifierProgram) throw new Error("pool has no deposit verifier registered");

  const builder = new TxBuilder(programId);
  const ixs = builder.deposit(bundle, amount, {
    pool: poolAddress,
    asset: assetAddress,
    mint,
    vault,
    depositorTokenAccount,
    depositor: wallet.publicKey,
    verifierProgram,
    tokenProgram,
  });

  const signature = await sendViaWallet(connection, wallet, ixs, alt);
  return { signature };
}

export interface PayOneRecipientOptions {
  connection: Connection;
  wallet: ConnectedWallet;
  programId: PublicKey;
  coordinatorUrl: string;
  indexerUrl: string;
  sessionId: string;
  proposalId: string;
  group: GroupRecord;
  proverPort: ProverPort;
  alt: SharedLookupTable;
  /** A REAL scanner-produced view (`MultisigScanEngine.sync`, or the `changeNote` returned by the
   *  previous `payOneRecipient` call) -- never a hand-built one. See `assertRealNoteView`. */
  sourceNote: MultisigNoteView;
  recipient: ReceiveAddress;
  amount: bigint;
  /** Every co-signer's ceremony participation needed to reach threshold. In the single-browser
   *  demo path (Playwright e2e) this includes this browser's own share plus others' posted
   *  independently to the same coordinator session; in production each co-signer runs
   *  `signProposal` themselves, from their own browser, against this same `proposalId`. */
  quorum: { myId: bigint; secretShare: bigint }[];
  ephemeralCounters?: InMemoryEphemeralCounterStore;
  /** Test seam: the `GET /notes` read `resolveChangeNote` polls; defaults to the real indexer. */
  notesTransport?: NotesTransport;
  /** How long `resolveChangeNote` waits for the indexer to ingest the confirmed transfer. */
  changeNoteTimeoutMs?: number;
}

export interface PayOneRecipientResult {
  signature: string;
  /** The REAL change note view (indexer-assigned leaf index, nullifier recomputed from it) --
   *  exactly what the next row must spend. */
  changeNote: MultisigNoteView;
  assembled: AssembledTransferMultisig;
}

/** The transient `ROOT_MISMATCH` the scenario documents (`e2e/scenario.test.ts`): the indexer's
 *  `/path` and `/root` are two round trips against a live store; retry a few times. */
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

/** A hand-built `MultisigNoteView` (e.g. `{...oldNote, value: v - amount}`) is exactly the bug
 *  class this file used to have: the FROST message is signed over the view's `nullifier` and the
 *  indexer's root, but the circuit re-derives both from the note fields + path it is given, so any
 *  view whose fields don't hash to a real leaf fails in-circuit with "FROST signature invalid". */
export function assertRealNoteView(view: MultisigNoteView, what = "sourceNote"): void {
  const n = view.note;
  if (
    !(view.commitment instanceof Fr) ||
    !(view.nullifier instanceof Fr) ||
    typeof view.leafIndex !== "number" ||
    !n ||
    !(n.psi instanceof Fr) ||
    !(n.owner instanceof Fr) ||
    !(n.parents instanceof Fr) ||
    !(n.assetId instanceof Fr)
  ) {
    throw new Error(`${what} is not a scanner-produced MultisigNoteView (missing commitment/nullifier/psi)`);
  }
}

export interface AssembleRowOptions {
  merkle: MerkleWitnessSource;
  counters: EphemeralCounterStore;
  gpk: Point;
  group: GroupRecord;
  compliancePk: Point;
  sourceNote: MultisigNoteView;
  recipient: ReceiveAddress;
  amount: bigint;
  memoEph?: Fr;
}

/** Stage 1 of a payroll row: the REAL witness assembly (`@kakure/cli`'s `assembleTransferMultisig`,
 *  the same call `e2e/scenario.test.ts` step 5 makes). Its `.message` is the exact `m` the quorum
 *  signs and the circuit recomputes. */
export async function assembleRow(opts: AssembleRowOptions): Promise<AssembledTransferMultisig> {
  assertRealNoteView(opts.sourceNote);
  return retryOnTransientWitnessMismatch(() =>
    assembleTransferMultisig(
      { merkle: opts.merkle, counters: opts.counters },
      {
        gpk: opts.gpk,
        v: new Fr(BigInt(opts.group.groupViewKey.v)),
        memberId: BigInt(opts.group.myId),
        compliancePk: opts.compliancePk,
        oldNoteView: opts.sourceNote,
        transferValue: opts.amount,
        recipientInPub: [opts.recipient.pubX, opts.recipient.pubY],
        recipientInKey: new Fr(0n), // inert for an incoming note -- see file doc comment
        memoEph: opts.memoEph ?? randomEvenYScalar(),
      },
    ),
  );
}

export interface RunTransferMultisigProposalOptions<Bundle> {
  coordinatorUrl: string;
  sessionId: string;
  proposalId: string;
  gpk: Point;
  group: GroupRecord;
  quorum: { myId: bigint; secretShare: bigint }[];
  assembled: AssembledTransferMultisig;
  prover: ProverLike<Bundle>;
  buildInstructions: (bundle: Bundle) => TxIx[];
  maxRounds?: number;
}

/** Stage 2: propose -> collect `threshold` signatures -> aggregate -> prove -> build instructions.
 *  Entirely `@kakure/cli`'s state machine (`createTransferMultisigProposal`, `signProposal`,
 *  `executeProposal`, `buildTransferMultisigInputsFromProposal`); nothing here re-derives notes,
 *  messages or inputs. Proving/instruction building are injected so tests can run the real
 *  circuit witness without Sunspot or a validator. */
export async function runTransferMultisigProposal<Bundle>(
  opts: RunTransferMultisigProposalOptions<Bundle>,
): Promise<{ bundle: Bundle; instructions: TxIx[] }> {
  const { coordinatorUrl, sessionId, proposalId, gpk, group, assembled } = opts;
  const coordinator = new CoordinatorClient(coordinatorUrl);
  // Envelopes are sealed to the group (slice-2 F-2): the session key is derived from the group view
  // secret every member holds, so the coordinator relays ciphertext only.
  const sessionKey = deriveSessionKeyFromGvsDecimal(group.groupViewKey.gvs, sessionId);
  await createTransferMultisigProposal(coordinator, sessionId, sessionKey, proposalId, assembled);

  await Promise.all(
    opts.quorum.map((signer) =>
      signProposal({
        coordinator: new CoordinatorClient(coordinatorUrl),
        sessionId,
        sessionKey,
        proposalId,
        myId: signer.myId,
        mySecretShare: signer.secretShare,
        gpk,
        threshold: group.threshold,
        ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
      }),
    ),
  );

  // Each signer's public share V_i is aggregated from every dealer's Feldman commitments
  // (`aggregatePublicShareAt`, same helper `runGroupCeremony`'s callers use to verify signature
  // shares) -- this is PUBLIC data already stored on the `GroupRecord`, no coordination needed.
  const dealerCommitmentsList: Point[][] = Object.values(group.dealerCommitments).map((commitments) =>
    commitments.map((c): Point => [BigInt("0x" + c.x), BigInt("0x" + c.y)]),
  );
  const publicShares = new Map<string, Point>(
    opts.quorum.map((signer) => [signer.myId.toString(), aggregatePublicShareAt(signer.myId, dealerCommitmentsList)]),
  );

  const result = await executeProposal<Bundle>({
    coordinator,
    sessionId,
    sessionKey,
    proposalId,
    gpk,
    threshold: group.threshold,
    publicShares,
    prover: opts.prover,
    buildInputs: (signature, proposal) => buildTransferMultisigInputsFromProposal(signature, proposal, gpk),
    buildInstructions: (bundle) => opts.buildInstructions(bundle),
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
  });
  return { bundle: result.bundle, instructions: result.instructions };
}

/** The change note's view, given the leaf index the pool assigned it. Every field comes from the
 *  assembly that was signed and proved (`partialInputs.changeNote` / `changeCommitment`), and the
 *  nullifier is `H(psi, leafIndex)` -- the same derivation the scanner and the circuit use. */
export async function changeNoteView(
  assembled: AssembledTransferMultisig,
  leafIndex: number,
  memberId?: bigint,
): Promise<MultisigNoteView> {
  const c = assembled.partialInputs.changeNote;
  return {
    note: {
      noteVersion: c.noteVersion,
      assetId: c.assetId,
      noteType: c.noteType,
      conditionsHash: c.conditionsHash,
      value: c.value.toBigInt(),
      owner: c.owner,
      psi: c.psi,
      parents: c.parents,
    },
    commitment: assembled.changeCommitment,
    leafIndex,
    nullifier: await computeNullifier(c.psi, new Fr(BigInt(leafIndex))),
    isIncoming: false,
    ...(memberId !== undefined ? { memberId } : {}),
  };
}

/** Stage 3: after the transfer confirms, wait for the indexer to report the change leaf and
 *  return its REAL view. Spec §2: "each tx re-fetches the Merkle witness after the previous
 *  confirms" -- the next row's `assembleRow` needs the indexer-assigned leaf index, and a view
 *  whose fields don't hash to that leaf is unprovable (see `assertRealNoteView`). */
export async function resolveChangeNote(
  transport: NotesTransport,
  assembled: AssembledTransferMultisig,
  opts: { fromLeafIndex: number; timeoutMs?: number; pollMs?: number; memberId?: bigint },
): Promise<MultisigNoteView> {
  const want = assembled.changeCommitment.toBigInt();
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const events = await transport.fetchNotes(opts.fromLeafIndex);
    const hit = events.find((e) => BigInt(e.leaf) === want);
    if (hit) return changeNoteView(assembled, Number(hit.leaf_index), opts.memberId);
    if (Date.now() >= deadline) {
      throw new Error(
        `change note ${assembled.changeCommitment.toString()} not reported by the indexer within ${opts.timeoutMs ?? 30_000}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
  }
}

/** `MultisigScanEngine.sync` returns every note it can open, spent or not; the pool's nullifier
 *  PDA is the only spent-ness record. Returns the unspent multisig-owned (non-incoming) notes,
 *  oldest first. */
export async function selectSpendableNotes(
  connection: Connection,
  programId: PublicKey,
  notes: readonly MultisigNoteView[],
): Promise<MultisigNoteView[]> {
  const candidates = notes.filter((n) => !n.isIncoming).sort((a, b) => a.leafIndex - b.leafIndex);
  if (candidates.length === 0) return [];
  const pdas = candidates.map((n) => nullifierPda(programId, frToBytes32(n.nullifier))[0]);
  const infos = await connection.getMultipleAccountsInfo(pdas);
  return candidates.filter((_, i) => infos[i] === null);
}

/**
 * Runs one `transfer_multisig` proposal to completion: assemble -> propose -> collect `threshold`
 * signatures -> execute (prove, build, send via the shared ALT) -> resolve the real change note.
 * Mirrors `e2e/scenario.test.ts` step 5. Call once per payroll row, threading `changeNote` from
 * one call into the next row's `sourceNote`.
 */
export async function payOneRecipient(opts: PayOneRecipientOptions): Promise<PayOneRecipientResult> {
  const { connection, programId, coordinatorUrl, sessionId, proposalId, group, proverPort, alt, sourceNote, recipient, amount, indexerUrl } =
    opts;
  assertRealNoteView(sourceNote);
  const gpk: Point = [BigInt("0x" + group.gpk.x), BigInt("0x" + group.gpk.y)];

  const [poolAddress] = poolPda(programId);
  const pool = await currentPool(connection, poolAddress);
  const compliancePk: Point = [bytesToBigIntBE(pool.compliancePkX), bytesToBigIntBE(pool.compliancePkY)];

  const merkle = new IndexerWitnessSource(indexerTransport(indexerUrl, () => sourceNote.leafIndex));
  const counters = opts.ephemeralCounters ?? new InMemoryEphemeralCounterStore();

  const assembled = await assembleRow({ merkle, counters, gpk, group, compliancePk, sourceNote, recipient, amount });

  const nullifierAddr = nullifierPda(programId, frToBytes32(sourceNote.nullifier))[0];
  const verifierProgram = pool.verifiers[CircuitId.TransferMultisig];
  if (!verifierProgram) throw new Error("pool has no transfer_multisig verifier registered");

  const { instructions } = await runTransferMultisigProposal({
    coordinatorUrl,
    sessionId,
    proposalId,
    gpk,
    group,
    quorum: opts.quorum,
    assembled,
    prover: { prove: (inputs) => proverPort.prove(CircuitId.TransferMultisig, inputs) },
    buildInstructions: (bundle) =>
      new TxBuilder(programId).transferMultisig(
        bundle,
        { pool: poolAddress, nullifier: nullifierAddr, payer: opts.wallet.publicKey, verifierProgram },
        pool,
      ),
  });

  const signature = await sendViaWallet(connection, opts.wallet, instructions, alt);

  const changeNote = await resolveChangeNote(opts.notesTransport ?? httpNotesTransport(indexerUrl), assembled, {
    fromLeafIndex: sourceNote.leafIndex + 1,
    memberId: BigInt(group.myId),
    ...(opts.changeNoteTimeoutMs !== undefined ? { timeoutMs: opts.changeNoteTimeoutMs } : {}),
  });

  return { signature, changeNote, assembled };
}

export function markRowStatus(rows: PayrollRow[], index: number, patch: Partial<PayrollRow>): PayrollRow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

/**
 * `@kakure/sdk/solana`'s `createSharedLookupTable`/`extendSharedLookupTable` take a `Keypair`
 * authority (they sign and send directly, `legacySend`) -- not usable from a browser, which only
 * ever has a wallet-adapter's `signTransaction`. These are the same two operations, built and sent
 * through `sendViaWallet` instead. Every real submission needs one shared ALT (spec's e2e proven
 * sequence): a real proof's public inputs make every `kakure_pool` instruction exceed the 1232-byte
 * legacy tx limit.
 */
export async function ensureLookupTable(connection: Connection, wallet: ConnectedWallet): Promise<SharedLookupTable> {
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendTransaction(signed as VersionedTransaction);
  await connection.confirmTransaction(sig, "confirmed");

  return {
    address,
    async account(conn: Connection): Promise<AddressLookupTableAccount> {
      const info = await conn.getAddressLookupTable(address);
      if (!info.value) throw new Error(`lookup table ${address.toBase58()} not found`);
      return info.value;
    },
  };
}

export async function extendLookupTableViaWallet(
  connection: Connection,
  wallet: ConnectedWallet,
  alt: SharedLookupTable,
  addresses: readonly PublicKey[],
): Promise<void> {
  if (addresses.length === 0) return;
  const ix = AddressLookupTableProgram.extendLookupTable({
    payer: wallet.publicKey,
    authority: wallet.publicKey,
    lookupTable: alt.address,
    addresses: [...addresses],
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendTransaction(signed as VersionedTransaction);
  await connection.confirmTransaction(sig, "confirmed");
  await waitForLookupTableActivation(connection, alt.address, await connection.getSlot("confirmed"));
}

/** Same warm-up `@kakure/sdk/solana`'s `extendSharedLookupTable` applies: a lookup table extended
 *  in slot S is not reliably usable by a transaction until well past S (see alt.ts's header,
 *  point 3), so wait `ALT_WARMUP_EXTRA_SLOTS` before referencing the new entries. */
export async function waitForLookupTableActivation(
  connection: Connection,
  altAddress: PublicKey,
  extendedAtSlot: number,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const slot = await connection.getSlot("confirmed");
    if (slot > extendedAtSlot + ALT_WARMUP_EXTRA_SLOTS) {
      const info = await connection.getAddressLookupTable(altAddress);
      if (info.value) return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`lookup table ${altAddress.toBase58()} did not activate within the wait budget`);
}
