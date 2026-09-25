import { CircuitId } from "@kakure/sdk/tx";

/** I-1 circuit id -> Sunspot artifact / Noir package name. */
export const CIRCUIT_NAMES: Readonly<Record<CircuitId, string>> = {
  [CircuitId.Deposit]: "deposit",
  [CircuitId.Transfer]: "transfer",
  [CircuitId.Withdraw]: "withdraw",
  [CircuitId.TransferMultisig]: "transfer_multisig",
  [CircuitId.SplitMultisig]: "split_multisig",
  [CircuitId.JoinMultisig]: "join_multisig",
  [CircuitId.WithdrawMultisig]: "withdraw_multisig",
};

export function circuitNameFor(id: CircuitId): string {
  const name = CIRCUIT_NAMES[id];
  if (name === undefined) throw new Error(`circuitNameFor: unknown CircuitId ${id}`);
  return name;
}
