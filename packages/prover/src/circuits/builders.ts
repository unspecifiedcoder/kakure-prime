/**
 * Per-circuit `InputMap` builders, keyed by the exact Noir parameter names declared in each
 * circuit's `main.nr` (see `circuits/{standard,multisig}/<name>/src/main.nr`). Struct-typed parameters
 * (`Note`, `ecdh::Point`) marshal to nested objects whose field names match the Noir struct
 * definition (`note_version`, `asset_id`, ... / `x`, `y`).
 */
import type { InputMap } from "@noir-lang/noir_js";
import { marshalNote, marshalU128, memoRecipientPoints, pointHex } from "../marshal.js";
import type {
  DepositInputs,
  JoinMultisigInputs,
  SplitMultisigInputs,
  TransferInputs,
  TransferMultisigInputs,
  WithdrawInputs,
  WithdrawMultisigInputs,
} from "./types.js";

function pathStrings(path: readonly { toString(): string }[]): string[] {
  return path.map((p) => p.toString());
}

export function buildDepositInputMap(inputs: DepositInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  return {
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    note: marshalNote("deposit", inputs.note),
    eph: inputs.eph.toString(),
  };
}

export function buildTransferInputMap(inputs: TransferInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  const recipient = memoRecipientPoints(
    "transfer",
    inputs.memoNote.noteType,
    inputs.recipientInPub,
    inputs.recipientMultisig,
  );
  return {
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    recipient_spend_pub: pointHex(recipient.spend),
    recipient_view_pub: pointHex(recipient.view),
    old_note: marshalNote("transfer", inputs.oldNote),
    spend_scalar: inputs.spendScalar.toString(),
    old_note_index: inputs.oldNoteIndex.toString(),
    old_note_path: pathStrings(inputs.oldNotePath),
    memo_note: marshalNote("transfer", inputs.memoNote),
    memo_eph: inputs.memoEph.toString(),
    change_note: marshalNote("transfer", inputs.changeNote),
    change_eph: inputs.changeEph.toString(),
  };
}

export function buildWithdrawInputMap(inputs: WithdrawInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  return {
    withdraw_value: marshalU128("withdraw", "withdraw_value", inputs.withdrawValue),
    // F-1: the circuit now binds these (`recipient != 0`, `intent_hash == 0`); param names match
    // `circuits/standard/withdraw/src/main.nr`.
    recipient: inputs.recipient.toString(),
    intent_hash: inputs.intentHash.toString(),
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    old_note: marshalNote("withdraw", inputs.oldNote),
    spend_scalar: inputs.spendScalar.toString(),
    old_note_index: inputs.oldNoteIndex.toString(),
    old_note_path: pathStrings(inputs.oldNotePath),
    change_note: marshalNote("withdraw", inputs.changeNote),
    change_eph: inputs.changeEph.toString(),
  };
}

export function buildTransferMultisigInputMap(inputs: TransferMultisigInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  const recipient = memoRecipientPoints(
    "transfer_multisig",
    inputs.memoNote.noteType,
    inputs.recipientInPub,
    inputs.recipientMultisig,
  );
  return {
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    gpk: pointHex(inputs.gpk),
    frost_r: pointHex(inputs.frostR),
    frost_z: inputs.frostZ.toString(),
    recipient_spend_pub: pointHex(recipient.spend),
    recipient_view_pub: pointHex(recipient.view),
    old_note: marshalNote("transfer_multisig", inputs.oldNote),
    old_note_index: inputs.oldNoteIndex.toString(),
    old_note_path: pathStrings(inputs.oldNotePath),
    memo_note: marshalNote("transfer_multisig", inputs.memoNote),
    memo_eph: inputs.memoEph.toString(),
    change_note: marshalNote("transfer_multisig", inputs.changeNote),
    change_eph: inputs.changeEph.toString(),
  };
}

export function buildSplitMultisigInputMap(inputs: SplitMultisigInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  return {
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    gpk: pointHex(inputs.gpk),
    frost_r: pointHex(inputs.frostR),
    frost_z: inputs.frostZ.toString(),
    note_in: marshalNote("split_multisig", inputs.noteIn),
    index_in: inputs.indexIn.toString(),
    path_in: pathStrings(inputs.pathIn),
    note_out_1: marshalNote("split_multisig", inputs.noteOut1),
    eph_1: inputs.eph1.toString(),
    note_out_2: marshalNote("split_multisig", inputs.noteOut2),
    eph_2: inputs.eph2.toString(),
  };
}

export function buildJoinMultisigInputMap(inputs: JoinMultisigInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  return {
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    gpk_a: pointHex(inputs.gpkA),
    frost_r_a: pointHex(inputs.frostRA),
    frost_z_a: inputs.frostZA.toString(),
    note_a: marshalNote("join_multisig", inputs.noteA),
    index_a: inputs.indexA.toString(),
    path_a: pathStrings(inputs.pathA),
    gpk_b: pointHex(inputs.gpkB),
    frost_r_b: pointHex(inputs.frostRB),
    frost_z_b: inputs.frostZB.toString(),
    note_b: marshalNote("join_multisig", inputs.noteB),
    index_b: inputs.indexB.toString(),
    path_b: pathStrings(inputs.pathB),
    note_out: marshalNote("join_multisig", inputs.noteOut),
    eph_out: inputs.ephOut.toString(),
  };
}

export function buildWithdrawMultisigInputMap(inputs: WithdrawMultisigInputs): InputMap {
  const c = pointHex(inputs.compliancePk);
  return {
    withdraw_value: marshalU128("withdraw_multisig", "withdraw_value", inputs.withdrawValue),
    recipient: inputs.recipient.toString(),
    intent_hash: inputs.intentHash.toString(),
    compliance_pubkey_x: c.x,
    compliance_pubkey_y: c.y,
    gpk: pointHex(inputs.gpk),
    frost_r: pointHex(inputs.frostR),
    frost_z: inputs.frostZ.toString(),
    old_note: marshalNote("withdraw_multisig", inputs.oldNote),
    old_note_index: inputs.oldNoteIndex.toString(),
    old_note_path: pathStrings(inputs.oldNotePath),
    change_note: marshalNote("withdraw_multisig", inputs.changeNote),
    change_eph: inputs.changeEph.toString(),
  };
}
