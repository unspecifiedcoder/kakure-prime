/**
 * Small app-level helpers over `@kakure/sdk/tss`'s Feldman primitives: computing a participant's
 * PUBLIC share from a dealer's public commitments alone (no share value, no secret) -- needed so
 * every signer can verify every other signer's FROST signature share without a third party. Not
 * part of `@kakure/sdk/tss` itself (that module stops at `feldmanVerifyShare`, which checks a
 * KNOWN share against commitments; this computes what a share WOULD be, from commitments only).
 */
import { IDENTITY, modSub, pointAdd, scalarMul, type Point } from "@kakure/sdk/tss";

/** `sum_k i^k * commitments[k]` -- the public commitment to participant `i`'s share. */
export function publicShareAt(i: bigint, commitments: readonly Point[]): Point {
  let rhs: Point = IDENTITY;
  let ipow = 1n;
  for (const com of commitments) {
    rhs = pointAdd(rhs, scalarMul(ipow, com));
    ipow = modSub(ipow * i);
  }
  return rhs;
}

/** Public V_i across ALL qualified dealers: `sum_dealers publicShareAt(i, dealer.commitments)`. */
export function aggregatePublicShareAt(i: bigint, dealerCommitments: readonly (readonly Point[])[]): Point {
  let acc: Point = IDENTITY;
  for (const commitments of dealerCommitments) acc = pointAdd(acc, publicShareAt(i, commitments));
  return acc;
}
