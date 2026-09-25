/**
 * `transfer_multisig` witness assembly. `@kakure/sdk`'s `tx/assemble.ts` only has the SINGLE-KEY
 * circuits (`assembleDeposit/Transfer/Split/Join/Withdraw`) -- there is no multisig equivalent
 * (deliberately out of the "changes needed in sdk" list this time, since it's genuinely app-level
 * glue over primitives sdk already exports: `frost/multisigNote.ts`'s `mintIncomingNote` (generic
 * over the memo, reused as-is), `multisigDepositEph` (self-family change ephemeral),
 * `note/nullifier.ts`'s `computePsi`, `note/note.ts`'s `leaf`/`packParents`, `crypto/kem.ts`'s
 * `deriveCek`, and `frost/message.ts`'s `msgTransfer` for the real signed message `m`.
 *
 * Scope: only `transfer_multisig` is wired (the case this workstream's prover already proves
 * end-to-end against the real KAT). `split_multisig`/`join_multisig`/`withdraw_multisig` follow
 * the identical pattern (open the multisig note(s) via the scanner, mint self/incoming outputs,
 * compute the matching `msg_*`) but are not implemented here -- flagged in the report.
 */
import type { Point as ZkPoint } from "@zk-kit/baby-jubjub";
import {
  Fr,
  PARENTS_HIDDEN,
  computePsi,
  deriveCek,
  leaf,
  mintIncomingNote,
  packParents,
  toFr,
  type EphemeralCounterStore,
  type MintedNote,
} from "@kakure/sdk";

type Point = ZkPoint<bigint>;
import { multisigOwner, msgTransfer, multisigDepositEph, type MultisigNoteView } from "@kakure/sdk/frost";
import type { MerkleWitnessSource } from "@kakure/sdk/solana";
import type { NoteInput } from "@kakure/prover";

export interface AssembleTransferMultisigRequest {
  readonly gpk: Point;
  readonly v: Fr;
  readonly memberId: bigint;
  readonly compliancePk: Point;
  readonly oldNoteView: MultisigNoteView;
  readonly transferValue: bigint;
  readonly recipientInPub: Point;
  readonly recipientInKey: Fr;
  readonly memoEph: Fr;
}

export interface AssembledTransferMultisig {
  /** The exact `InputMap`-building shape `@kakure/prover`'s `buildTransferMultisigInputMap`
   *  expects, minus `gpk`/`frostR`/`frostZ` (filled in by the caller once the FROST signature is
   *  aggregated -- assembly happens once, per note, independent of who ends up signing). */
  readonly partialInputs: {
    compliancePk: Point;
    recipientInPub: Point;
    oldNote: NoteInput;
    oldNoteIndex: number;
    oldNotePath: Fr[];
    memoNote: NoteInput;
    memoEph: Fr;
    changeNote: NoteInput;
    changeEph: Fr;
  };
  /** `msg_transfer`'s output -- the exact bytes (as a bigint) the FROST signature must cover. */
  readonly message: bigint;
  readonly memo: MintedNote;
  readonly changeCommitment: Fr;
  readonly root: Fr;
}

function toNoteInput(note: {
  noteVersion: Fr;
  assetId: Fr;
  noteType: Fr;
  conditionsHash: Fr;
  value: Fr | bigint;
  owner: Fr;
  psi: Fr;
  parents: Fr;
}): NoteInput {
  return {
    noteVersion: note.noteVersion,
    assetId: note.assetId,
    noteType: note.noteType,
    conditionsHash: note.conditionsHash,
    value: typeof note.value === "bigint" ? new Fr(note.value) : note.value,
    owner: note.owner,
    psi: note.psi,
    parents: note.parents,
  };
}

/** Mirrors `note/mint.ts`'s private `finish()`, but with the MULTISIG owner (`Poseidon2(gpk)`)
 *  instead of a personal spend key's `pubkeyOwner` -- `mintSelfNote` cannot be reused as-is. */
async function mintSelfNoteMultisig(
  eph: Fr,
  value: bigint,
  assetId: Fr,
  compliancePk: Point,
  gpk: Point,
  parents: Fr,
): Promise<{ note: NoteInput; commitment: Fr }> {
  const owner = new Fr(await multisigOwner(gpk));
  const cek = deriveCek(eph, compliancePk);
  const psi = await computePsi(cek);
  const note: NoteInput = {
    noteVersion: new Fr(1n),
    assetId,
    noteType: new Fr(1n), // NOTE_TYPE_MULTISIG
    conditionsHash: new Fr(0n),
    value: new Fr(value),
    owner,
    psi,
    parents,
  };
  const commitment = await leaf({
    noteVersion: note.noteVersion,
    assetId: note.assetId,
    noteType: note.noteType,
    conditionsHash: note.conditionsHash,
    value,
    owner: note.owner,
    psi: note.psi,
    parents: note.parents,
  });
  return { note, commitment };
}

export async function assembleTransferMultisig(
  ctx: { merkle: MerkleWitnessSource; counters: EphemeralCounterStore },
  req: AssembleTransferMultisigRequest,
): Promise<AssembledTransferMultisig> {
  const { oldNoteView } = req;
  const w = await ctx.merkle.witnessFor(oldNoteView.commitment);
  if (w.leafIndex !== oldNoteView.leafIndex) {
    throw new Error(
      `assembleTransferMultisig: merkle source placed the note at index ${w.leafIndex}, scanner has ${oldNoteView.leafIndex}`,
    );
  }
  const changeValue = oldNoteView.note.value - req.transferValue;
  if (changeValue < 0n) {
    throw new Error("assembleTransferMultisig: transfer value exceeds the note's value");
  }

  const changeEph = await multisigDepositEph(req.v, req.memberId, ctx.counters, req.gpk);
  const parents = packParents([{ leafIndex: w.leafIndex }, { leafIndex: 0 }]);
  const change = await mintSelfNoteMultisig(
    changeEph.eph,
    changeValue,
    oldNoteView.note.assetId,
    req.compliancePk,
    req.gpk,
    parents,
  );

  const memo = await mintIncomingNote(
    req.memoEph,
    req.transferValue,
    req.recipientInPub,
    req.recipientInKey,
    oldNoteView.note.assetId,
    req.compliancePk,
    PARENTS_HIDDEN,
  );

  const message = await msgTransfer({
    root: w.root.toBigInt(),
    nullifier: oldNoteView.nullifier.toBigInt(),
    memoLeaf: memo.commitment.toBigInt(),
    memoTag: memo.tag.toBigInt(),
    changeLeaf: change.commitment.toBigInt(),
    asset: oldNoteView.note.assetId.toBigInt(),
  });

  return {
    partialInputs: {
      compliancePk: req.compliancePk,
      recipientInPub: req.recipientInPub,
      oldNote: toNoteInput({ ...oldNoteView.note, value: toFr(oldNoteView.note.value) }),
      oldNoteIndex: w.leafIndex,
      oldNotePath: [...w.siblings],
      memoNote: toNoteInput(memo.note),
      memoEph: req.memoEph,
      changeNote: change.note,
      changeEph: changeEph.eph,
    },
    message,
    memo,
    changeCommitment: change.commitment,
    root: w.root,
  };
}
