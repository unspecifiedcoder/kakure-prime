/**
 * Glues `assembleTransferMultisig` (real note/witness assembly) to the `propose`/`sign`/`execute`
 * state machine: the proposer assembles the witness ONCE (it needs local secrets -- the group view
 * secret `v`, the ephemeral counter store -- that other signers don't have), serializes the
 * resulting `partialInputs` into the proposal's `details` (so ANY executor, not just the proposer,
 * can finish the job once shares are aggregated), and posts `msg_transfer`'s real output as the
 * proposal's `messageHex` -- the exact bytes every signer's FROST share covers.
 */
import { Fr } from "@kakure/sdk";
import { buildTransferMultisigInputMap, type NoteInput } from "@kakure/prover";
import type { Point } from "@kakure/sdk/tss";
import type { CoordinatorClient } from "../coordinatorClient.js";
import { createProposal, type ProposalPayload } from "./proposal.js";
import type { AssembledTransferMultisig } from "./assembleTransferMultisig.js";

function noteToHex(n: NoteInput): Record<string, string> {
  return {
    noteVersion: n.noteVersion.toString(),
    assetId: n.assetId.toString(),
    noteType: n.noteType.toString(),
    conditionsHash: n.conditionsHash.toString(),
    value: n.value.toString(),
    owner: n.owner.toString(),
    psi: n.psi.toString(),
    parents: n.parents.toString(),
  };
}
function noteFromHex(h: Record<string, string>): NoteInput {
  return {
    noteVersion: new Fr(BigInt(h.noteVersion)),
    assetId: new Fr(BigInt(h.assetId)),
    noteType: new Fr(BigInt(h.noteType)),
    conditionsHash: new Fr(BigInt(h.conditionsHash)),
    value: new Fr(BigInt(h.value)),
    owner: new Fr(BigInt(h.owner)),
    psi: new Fr(BigInt(h.psi)),
    parents: new Fr(BigInt(h.parents)),
  };
}
function pointToHex(p: Point): { x: string; y: string } {
  return { x: p[0].toString(), y: p[1].toString() };
}
function pointFromHexDec(h: { x: string; y: string }): Point {
  return [BigInt(h.x), BigInt(h.y)];
}

export interface TransferMultisigProposalDetails {
  compliancePk: { x: string; y: string };
  recipientInPub: { x: string; y: string };
  oldNote: Record<string, string>;
  oldNoteIndex: number;
  oldNotePath: string[];
  memoNote: Record<string, string>;
  memoEph: string;
  changeNote: Record<string, string>;
  changeEph: string;
}

export function serializeAssembledTransferMultisig(
  assembled: AssembledTransferMultisig,
): TransferMultisigProposalDetails {
  const p = assembled.partialInputs;
  return {
    compliancePk: pointToHex(p.compliancePk as Point),
    recipientInPub: pointToHex(p.recipientInPub as Point),
    oldNote: noteToHex(p.oldNote),
    oldNoteIndex: p.oldNoteIndex,
    oldNotePath: p.oldNotePath.map((f) => f.toString()),
    memoNote: noteToHex(p.memoNote),
    memoEph: p.memoEph.toString(),
    changeNote: noteToHex(p.changeNote),
    changeEph: p.changeEph.toString(),
  };
}

export async function createTransferMultisigProposal(
  coordinator: CoordinatorClient,
  sessionId: string,
  sessionKey: Uint8Array,
  proposalId: string,
  assembled: AssembledTransferMultisig,
): Promise<void> {
  await createProposal(coordinator, sessionId, sessionKey, {
    kind: "transfer",
    proposalId,
    messageHex: "0x" + assembled.message.toString(16),
    details: serializeAssembledTransferMultisig(assembled) as unknown as Record<string, unknown>,
  });
}

/** `buildInputs` for `proposal/execute.ts`'s `executeProposal`: turns the aggregated FROST
 *  signature plus the proposal's stored (real) assembly output into the exact `InputMap`
 *  `@kakure/prover`'s `prove(CircuitId.TransferMultisig, ...)` expects. */
export function buildTransferMultisigInputsFromProposal(
  signature: { R: Point; z: bigint },
  proposal: ProposalPayload,
  gpk: Point,
): Record<string, unknown> {
  const d = proposal.details as unknown as TransferMultisigProposalDetails;
  return buildTransferMultisigInputMap({
    compliancePk: [...pointFromHexDec(d.compliancePk)],
    gpk: [...gpk],
    frostR: [...signature.R],
    frostZ: new Fr(signature.z),
    recipientInPub: [...pointFromHexDec(d.recipientInPub)],
    oldNote: noteFromHex(d.oldNote),
    oldNoteIndex: d.oldNoteIndex,
    oldNotePath: d.oldNotePath.map((s) => new Fr(BigInt(s))),
    memoNote: noteFromHex(d.memoNote),
    memoEph: new Fr(BigInt(d.memoEph)),
    changeNote: noteFromHex(d.changeNote),
    changeEph: new Fr(BigInt(d.changeEph)),
  });
}
