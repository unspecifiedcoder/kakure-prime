/**
 * Spec §1.1 "Pay people": table or CSV of `address, amount, memo`. Parsing/validation is pure and
 * has no idea about proofs/proposals/FROST -- that orchestration lives in `treasuryFlows.ts` and
 * takes a `PayrollRow[]` this module already validated.
 *
 * "address" here is a recipient's Kakure pay address (`receiveAddress.ts`'s encoded
 * `ReceiveAddress`), NOT their raw Solana wallet address -- minting a private note to someone
 * needs their `canonicalIncomingAddress` public point, which only they can derive (see
 * `treasuryFlows.ts`'s file doc comment), so they share this once, ahead of being paid.
 */
import { decodeReceiveAddress } from "./receiveAddress.js";

export type PayrollRowStatus =
  | "pending"
  | "proving"
  | "awaiting-signatures"
  | "submitting"
  | "confirmed"
  | "failed";

export interface PayrollRow {
  address: string;
  amount: bigint;
  memo: string;
  status: PayrollRowStatus;
  error?: string;
  /** Filled in once the row's transfer executes -- the recipient's claim link. */
  claimLink?: string;
}

export class PayrollParseError extends Error {
  constructor(public readonly lineErrors: { line: number; message: string }[]) {
    super(`payroll CSV has ${lineErrors.length} invalid row(s)`);
    this.name = "PayrollParseError";
  }
}

function parseHumanAmount(raw: string, decimals: number): bigint | undefined {
  const clean = raw.trim().replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return undefined;
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) return undefined;
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return value > 0n ? value : undefined;
}

function parseAmount(raw: string): bigint | undefined {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  try {
    const value = BigInt(trimmed);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

function isValidAddress(raw: string): boolean {
  try {
    decodeReceiveAddress(raw.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses `address,amount,memo` CSV text (one row per line, an optional header row is skipped when
 * its first cell doesn't parse as a pay address) into validated `PayrollRow`s. Amount is the
 * smallest unit (e.g. USDC base units) as a plain integer string -- no decimals, no currency
 * symbols, so the UI can show "1,500 USDC" without this parser having to know an asset's decimal
 * count.
 */
/** `decimals` set: amounts are read as human token amounts ("1500.25") and scaled to smallest
 *  units; unset: amounts are whole numbers of smallest units (the legacy/CSV-export form). */
export function parsePayrollCsv(csv: string, opts: { decimals?: number } = {}): PayrollRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const errors: { line: number; message: string }[] = [];
  const rows: PayrollRow[] = [];

  lines.forEach((line, idx) => {
    const cells = line.split(",").map((c) => c.trim());
    const [address, amountRaw, ...memoParts] = cells;
    if (idx === 0 && address !== undefined && !isValidAddress(address) && parseAmount(amountRaw ?? "") === undefined) {
      return; // header row, e.g. "address,amount,memo" -- neither cell parses as real data
    }
    if (address === undefined || amountRaw === undefined) {
      errors.push({ line: idx + 1, message: "expected address,amount[,memo]" });
      return;
    }
    if (!isValidAddress(address)) {
      errors.push({ line: idx + 1, message: `"${address}" is not a valid Kakure pay address` });
      return;
    }
    const amount = opts.decimals === undefined ? parseAmount(amountRaw) : parseHumanAmount(amountRaw, opts.decimals);
    if (amount === undefined) {
      errors.push({
        line: idx + 1,
        message: opts.decimals === undefined ? `"${amountRaw}" is not a positive whole number` : `"${amountRaw}" is not a positive amount`,
      });
      return;
    }
    rows.push({ address, amount, memo: memoParts.join(",").trim(), status: "pending" });
  });

  if (errors.length > 0) throw new PayrollParseError(errors);
  return rows;
}

export function totalAmount(rows: readonly PayrollRow[]): bigint {
  return rows.reduce((sum, r) => sum + r.amount, 0n);
}
