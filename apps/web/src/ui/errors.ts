/** Every thrown error a person can hit, in the interface's voice: what happened and what to do.
 *  Anything unmapped keeps its raw message under "Details". */
const RULES: readonly { test: RegExp; message: string }[] = [
  { test: /user rejected|rejected the request|4001/i, message: "Your wallet declined the request. Nothing was sent." },
  { test: /no spendable treasury note/i, message: "This treasury has nothing to spend yet. Fund it first, then pay." },
  { test: /ROOT_MISMATCH/i, message: "The ledger moved while we were reading it. Try again — this usually clears in a few seconds." },
  { test: /helper rejected the token|HelperUnauthorized/i, message: "The Kakure Helper token is wrong or has changed. Paste the current one from the helper's startup output in Settings." },
  { test: /could not reach the kakure helper|HelperUnreachable|fetch failed|Failed to fetch/i, message: "Could not reach the Kakure Helper on this computer. Start it, then try again." },
  { test: /insufficient funds|insufficient lamports|0x1\b/i, message: "Your wallet does not have enough SOL to pay the network fee." },
  { test: /NullifierSpent|already been withdrawn/i, message: "This payment was already spent." },
  { test: /StaleRoot/i, message: "The network moved on while proving. Try again." },
  { test: /wrong passphrase|KeystoreDecryptError/i, message: "Wrong passphrase — it does not unlock this treasury." },
  { test: /transfer value exceeds/i, message: "That amount is more than the treasury holds." },
  { test: /program id|Set the pool program/i, message: "Set the pool program id in Settings before paying." },
];

export function humanizeError(err: unknown): { message: string; detail?: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const hit = RULES.find((r) => r.test.test(raw));
  return hit ? { message: hit.message, detail: raw } : { message: raw };
}
