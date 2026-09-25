/**
 * Spec §1.2: "Claim link encodes: indexer URL, the recipient's incoming address hint and the leaf
 * index range to scan (no secrets)." Kept in its own pure module (no crypto/network imports) so a
 * test can assert its shape cheaply and so the claim page's "no spend-key input" test has an
 * obviously-safe encoder to point at.
 */
export interface ClaimToken {
  indexerUrl: string;
  /** A hint only -- e.g. a truncated/display form of the canonical incoming address, NOT a key.
   *  Scanning still has to decrypt every candidate note; this narrows which ones are worth trying. */
  incomingAddressHint: string;
  fromLeaf: number;
  toLeaf: number;
  /** Where to withdraw FROM: the pool program and the SPL mint the payment is in. Both public
   *  (they identify the pool, not the recipient); without them the claim page can only show the
   *  payment, not withdraw it. */
  programId?: string;
  mint?: string;
  /** Public RPC endpoint of the network the payment lives on (same trust class as `indexerUrl`). */
  rpcUrl?: string;
  /** Display only: the token's decimals/symbol and who is paying. Public, non-binding -- the
   *  amount shown always comes from the decrypted note, these only format it. */
  decimals?: number;
  symbol?: string;
  payerName?: string;
}

export function encodeClaimToken(token: ClaimToken): string {
  const json = JSON.stringify(token);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeClaimToken(encoded: string): ClaimToken {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(escape(atob(b64)));
  const parsed = JSON.parse(json) as Partial<ClaimToken>;
  if (
    typeof parsed.indexerUrl !== "string" ||
    typeof parsed.incomingAddressHint !== "string" ||
    typeof parsed.fromLeaf !== "number" ||
    typeof parsed.toLeaf !== "number" ||
    (parsed.programId !== undefined && typeof parsed.programId !== "string") ||
    (parsed.mint !== undefined && typeof parsed.mint !== "string") ||
    (parsed.rpcUrl !== undefined && typeof parsed.rpcUrl !== "string") ||
    (parsed.decimals !== undefined && typeof parsed.decimals !== "number") ||
    (parsed.symbol !== undefined && typeof parsed.symbol !== "string") ||
    (parsed.payerName !== undefined && typeof parsed.payerName !== "string")
  ) {
    throw new Error("claim link is malformed or corrupted");
  }
  return parsed as ClaimToken;
}
