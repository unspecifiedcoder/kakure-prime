import type { Fr } from "@kakure/sdk";
import type { Point } from "@zk-kit/baby-jubjub";
import type { NoteInput } from "../marshal.js";

export interface MultisigMemoRecipient {
  gpk: Point<bigint>;
  viewPub: Point<bigint>;
}

export interface DepositInputs {
  compliancePk: Point<bigint>;
  note: NoteInput;
  eph: Fr;
}

export interface TransferInputs {
  compliancePk: Point<bigint>;
  recipientInPub?: Point<bigint>;
  recipientMultisig?: MultisigMemoRecipient;
  oldNote: NoteInput;
  spendScalar: Fr;
  oldNoteIndex: number;
  oldNotePath: Fr[];
  memoNote: NoteInput;
  memoEph: Fr;
  changeNote: NoteInput;
  changeEph: Fr;
}

export interface WithdrawInputs {
  withdrawValue: Fr;
  recipient: Fr;
  intentHash: Fr;
  compliancePk: Point<bigint>;
  oldNote: NoteInput;
  spendScalar: Fr;
  oldNoteIndex: number;
  oldNotePath: Fr[];
  changeNote: NoteInput;
  changeEph: Fr;
}

export interface TransferMultisigInputs {
  compliancePk: Point<bigint>;
  gpk: Point<bigint>;
  frostR: Point<bigint>;
  frostZ: Fr;
  recipientInPub?: Point<bigint>;
  recipientMultisig?: MultisigMemoRecipient;
  oldNote: NoteInput;
  oldNoteIndex: number;
  oldNotePath: Fr[];
  memoNote: NoteInput;
  memoEph: Fr;
  changeNote: NoteInput;
  changeEph: Fr;
}

export interface SplitMultisigInputs {
  compliancePk: Point<bigint>;
  gpk: Point<bigint>;
  frostR: Point<bigint>;
  frostZ: Fr;
  noteIn: NoteInput;
  indexIn: number;
  pathIn: Fr[];
  noteOut1: NoteInput;
  eph1: Fr;
  noteOut2: NoteInput;
  eph2: Fr;
}

export interface JoinMultisigInputs {
  compliancePk: Point<bigint>;
  gpkA: Point<bigint>;
  frostRA: Point<bigint>;
  frostZA: Fr;
  noteA: NoteInput;
  indexA: number;
  pathA: Fr[];
  gpkB: Point<bigint>;
  frostRB: Point<bigint>;
  frostZB: Fr;
  noteB: NoteInput;
  indexB: number;
  pathB: Fr[];
  noteOut: NoteInput;
  ephOut: Fr;
}

export interface WithdrawMultisigInputs {
  withdrawValue: Fr;
  recipient: Fr;
  intentHash: Fr;
  compliancePk: Point<bigint>;
  gpk: Point<bigint>;
  frostR: Point<bigint>;
  frostZ: Fr;
  oldNote: NoteInput;
  oldNoteIndex: number;
  oldNotePath: Fr[];
  changeNote: NoteInput;
  changeEph: Fr;
}
