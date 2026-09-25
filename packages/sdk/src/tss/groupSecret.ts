/**
 * Group-shared view secret, established during DKG rather than derived from any one member's account.
 *
 * Bug this fixes: `frost/groupViewKey.ts`'s original `deriveGroupViewKey(account, gpk)` derived `v` from
 * the CALLING member's own personal view key. That is fine for a spend-key VSS share (each member's share
 * is legitimately different), but `v` is a VIEW secret every member is supposed to hold identically -- with
 * the old function, every member who was not the ceremony's "creator" computed a different `v` (and so a
 * different `V`), leaving the treasury with no single canonical `(gpk, V)` receiving address anyone besides
 * the creator could reconstruct.
 *
 * The fix: each member `i` samples a random 32-byte `r_i` and distributes it to every other member inside
 * the DKG's existing round-2 messages (pairwise-encrypted -- see `packages/cli/src/crypto/seal.ts` -- so
 * the coordinator relaying those messages never learns any `r_i`). Once every member holds the full set
 * `{r_1, ..., r_n}`, `combineGroupViewContributions` below computes the SAME `gvs` for everyone, which
 * `frost/groupViewKey.ts`'s `deriveGroupViewKeyFromSecret` turns into the canonical `(v, V)`.
 */
import { Fr } from "@aztec/foundation/fields";
import { sha256 } from "@noble/hashes/sha2";
import { Poseidon } from "../crypto/Poseidon.js";
import { toReducedFr } from "../crypto/fields.js";
import { GROUP_VIEW_DOMAIN } from "./domains.js";
import type { Point } from "./bjj.js";

/** Fixed width per the design: a 32-byte random contribution per member. */
export const GROUP_VIEW_CONTRIBUTION_BYTES = 32;

export interface GroupViewContribution {
  /** The contributing member's participant id/index (matches the DKG's own participant numbering). */
  readonly index: number;
  /** 32 bytes of randomness this member sampled and distributed pairwise-encrypted in round 2. */
  readonly r: Uint8Array;
}

function assertContributions(
  contribs: readonly GroupViewContribution[],
): readonly GroupViewContribution[] {
  if (contribs.length === 0) {
    throw new Error("combineGroupViewContributions: at least one contribution is required");
  }
  const seen = new Set<number>();
  for (const c of contribs) {
    if (c.r.length !== GROUP_VIEW_CONTRIBUTION_BYTES) {
      throw new Error(
        `combineGroupViewContributions: member ${c.index}'s contribution must be ` +
          `${GROUP_VIEW_CONTRIBUTION_BYTES} bytes, got ${c.r.length}`,
      );
    }
    if (seen.has(c.index)) {
      throw new Error(
        `combineGroupViewContributions: duplicate contribution for member ${c.index}`,
      );
    }
    seen.add(c.index);
  }
  // Sorting by index is what makes this order-independent: callers may collect contributions in
  // whatever order round-2 messages arrive, and must still land on the same `gvs`.
  return [...contribs].sort((a, b) => a.index - b.index);
}

/**
 * `gvs = Poseidon2([GROUP_VIEW_DOMAIN, gpk.x, gpk.y, H(r_1 || ... || r_n sorted by member index)])`.
 *
 * `H` is `sha256` over the raw concatenated bytes (not Poseidon2 -- the contributions are opaque 32-byte
 * strings from an out-of-circuit ceremony, so there is no circuit-side reason to keep them in-field before
 * mixing; `sha256` is cheap and already a dependency here). The result is wide-reduced into the BN254
 * scalar field before being folded into the Poseidon2 hash with `gpk`, binding `gvs` to this exact group.
 */
export async function combineGroupViewContributions(
  contribs: readonly GroupViewContribution[],
  gpk: Point,
): Promise<Fr> {
  const sorted = assertContributions(contribs);
  const concatenated = new Uint8Array(sorted.length * GROUP_VIEW_CONTRIBUTION_BYTES);
  sorted.forEach((c, i) => {
    concatenated.set(c.r, i * GROUP_VIEW_CONTRIBUTION_BYTES);
  });
  const digest = sha256(concatenated);
  const hFr = toReducedFr("0x" + Buffer.from(digest).toString("hex"));
  return Poseidon.hash([new Fr(GROUP_VIEW_DOMAIN), new Fr(gpk[0]), new Fr(gpk[1]), hFr]);
}
