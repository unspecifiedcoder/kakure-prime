/**
 * `PoolError` decoding (programs/kakure_pool/src/error.rs): `impl From<PoolError> for
 * ProgramError` maps every variant to `ProgramError::Custom(e as u32)`, i.e. the variant's
 * 0-based declaration order. This list MUST stay in that exact order -- it is also the
 * `errors` array in `solana/idl/kakure_pool.json`, which documents the same mapping.
 */
export const POOL_ERROR_NAMES = [
  "Paused",
  "InvalidPublicInputCount",
  "ComplianceKeyStale",
  "StaleRoot",
  "NullifierSpent",
  "InvalidProof",
  "InvalidLeaf",
  "AmountMismatch",
  "AssetMismatch",
  "AssetCollision",
  "RecipientMismatch",
  "IntentHashNotZero",
  "UnsupportedMint",
  "VerifierUnset",
] as const;

export type PoolErrorName = (typeof POOL_ERROR_NAMES)[number];

/**
 * `GnarkError` decoding (`/root/sunspot/gnark-solana/crates/verifier-lib/src/error.rs`'s
 * `impl From<GnarkError> for u32`): this list MUST stay in that exact declaration order.
 */
export const GNARK_ERROR_NAMES = [
  "IncompatibleVerifyingKeyWithNrPublicInputs",
  "ProofVerificationFailed",
  "PreparingInputsG1AdditionFailed",
  "PreparingInputsG1MulFailed",
  "InvalidG1Length",
  "InvalidG2Length",
  "InvalidPublicInputsLength",
  "DecompressingG1Failed",
  "DecompressingG2Failed",
  "PublicInputGreaterThanFieldSize",
  "ArkworksSerializationError",
  "ProofConversionError",
  "SolanaBN254Error",
  "HashError",
  "PedersenVerificationError",
  "PublicWitnessParsingError",
] as const;

export type GnarkErrorName = (typeof GNARK_ERROR_NAMES)[number];

function customCodeFromInstructionError(value: unknown): number | undefined {
  // web3.js `SendTransactionError`/simulation results carry `err.InstructionError = [index, detail]`,
  // where `detail` is either the string `"Custom"` (rare) or `{ Custom: n }`.
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if ("InstructionError" in obj && Array.isArray(obj["InstructionError"])) {
    const detail = obj["InstructionError"][1];
    if (detail && typeof detail === "object" && "Custom" in (detail as Record<string, unknown>)) {
      const n = (detail as Record<string, unknown>)["Custom"];
      return typeof n === "number" ? n : undefined;
    }
    return undefined;
  }
  if ("Custom" in obj) {
    const n = obj["Custom"];
    return typeof n === "number" ? n : undefined;
  }
  return undefined;
}

function customCodeFromMessage(message: string): number | undefined {
  // The standard Solana RPC/CLI error text: "... custom program error: 0x<hex>".
  const hexMatch = /custom program error: 0x([0-9a-fA-F]+)/.exec(message);
  if (hexMatch) return parseInt(hexMatch[1]!, 16);
  // Some tooling instead prints the Rust Debug form, "Custom(<decimal>)".
  const decMatch = /Custom\((\d+)\)/.exec(message);
  if (decMatch) return parseInt(decMatch[1]!, 10);
  return undefined;
}

/**
 * Extracts a raw `Custom(n)` code from whatever shape the caller has on hand: a plain number, a
 * `{ InstructionError: [index, { Custom: n }] }`-shaped transaction error object (as returned by
 * `sendAndConfirmTransaction`, simulation results, or `SendTransactionError.transactionError`),
 * or an `Error` whose message contains the RPC's rendered form. Returns `undefined` when no
 * custom code can be found (e.g. the failure was not a program error at all).
 */
export function extractCustomErrorCode(err: unknown): number | undefined {
  if (typeof err === "number") return err;
  if (err instanceof Error) {
    const fromInstr = customCodeFromInstructionError(
      (err as unknown as { transactionError?: unknown }).transactionError,
    );
    if (fromInstr !== undefined) return fromInstr;
    return customCodeFromMessage(err.message);
  }
  const fromInstr = customCodeFromInstructionError(err);
  if (fromInstr !== undefined) return fromInstr;
  if (typeof err === "string") return customCodeFromMessage(err);
  return undefined;
}

function isInvalidInstructionDataError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as Record<string, unknown>;
  if (!("InstructionError" in obj) || !Array.isArray(obj["InstructionError"])) return false;
  return obj["InstructionError"][1] === "InvalidInstructionData";
}

/** The program named in the transaction's top-level `Program <id> invoke [1]` log line -- the
 *  program the CLIENT's instruction actually targeted (always `kakure_pool` for every
 *  `PoolInstruction`; a verifier is only ever reached one level deeper, via CPI). */
function topLevelInvokedProgram(logs: readonly string[] | undefined): string | undefined {
  if (!logs) return undefined;
  for (const line of logs) {
    const m = /^Program (\S+) invoke \[1\]$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** The program named in the FIRST `Program <id> failed` line. Failures are logged from the
 *  deepest open frame outward as the runtime unwinds a failed instruction, so the first such line
 *  in log order names the innermost program that actually failed (see this file's module doc and
 *  slice-2 F-6). */
function innermostFailingProgram(logs: readonly string[] | undefined): string | undefined {
  if (!logs) return undefined;
  for (const line of logs) {
    const m = /^Program (\S+) failed/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Maps a `ProgramError::Custom(n)` (from any of `extractCustomErrorCode`'s accepted shapes) to
 * its `PoolError` name. Returns `undefined` when the code is out of range (not one of ours -- it
 * may belong to a CPI'd program, e.g. the SPL token program or a verifier) or when no custom code
 * could be extracted at all.
 *
 * slice-2 F-6: any `Custom(n)`/`InvalidInstructionData` surfaced by a FAILED verifier CPI is the
 * VERIFIER's own error code, not the pool's -- `verify.rs`'s `verify_cpi` cannot rewrite it (a
 * failing `invoke()` aborts the transaction with the callee's error; the caller's code never runs
 * again, see `verify.rs`'s module doc). Blindly indexing `POOL_ERROR_NAMES` with that code
 * misattributes it to an unrelated `PoolError` (e.g. the verifier's `PublicInputGreaterThanFieldSize`
 * = `Custom(9)` would print as the pool's `AssetCollision`). Passing `logs` (the transaction's
 * `meta.logMessages`) lets this tell the two cases apart: when the innermost failing program (the
 * first `Program X failed` line) is NOT the top-level invoked program (the client's own
 * instruction target, i.e. `kakure_pool`), the failure happened inside a CPI'd program instead --
 * report it as `InvalidProof` (verifier rejected the proof outright) or `VerifierError(<name>)`
 * (a `GnarkError`, e.g. a malformed proof/witness) rather than a `PoolError`. Without `logs` (or
 * when the log shows no nested CPI failure), this falls back to the pool's own error table, exactly
 * as before -- fully backward compatible with every existing single-argument call site.
 */
export function decodePoolError(
  err: unknown,
  logs?: readonly string[],
): PoolErrorName | `VerifierError(${GnarkErrorName})` | undefined {
  const topLevel = topLevelInvokedProgram(logs);
  const innermost = innermostFailingProgram(logs);
  const cpiFailed = topLevel !== undefined && innermost !== undefined && innermost !== topLevel;

  if (cpiFailed) {
    if (isInvalidInstructionDataError(err)) return "InvalidProof";
    const code = extractCustomErrorCode(err);
    if (code === undefined || code < 0 || code >= GNARK_ERROR_NAMES.length) return undefined;
    return `VerifierError(${GNARK_ERROR_NAMES[code]})`;
  }

  const code = extractCustomErrorCode(err);
  if (code === undefined || code < 0 || code >= POOL_ERROR_NAMES.length) return undefined;
  return POOL_ERROR_NAMES[code];
}
