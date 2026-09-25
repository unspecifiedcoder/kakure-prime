import { Fr } from "@aztec/foundation/fields";
import { Point } from "@zk-kit/baby-jubjub";
import { Kdf } from "../crypto/Kdf.js";
import { Poseidon } from "../crypto/Poseidon.js";
import { toBjjScalar } from "../crypto/index.js";
import { isEvenY, publicKey } from "../note/keys.js";
import type { IDarkAccount } from "../interfaces.js";

// `v` drives every multisig discovery key, so a group that loses it cannot find its own notes. Sampling it
// as a sum of member contributions made it recoverable by nobody. Contributory generation is essential for
// a SPEND key and buys nothing for a VIEW key, because 1-of-n view means every member holds `v` anyway.
//
// Bound to `gpk`, which is public, so the creator recomputes it from their seed alone, and two groups under
// one seed stay independent. Does NOT give an arbitrary member recovery; that needs `v` under VSS.

const MS_VIEW_LABEL = "kakure.msView";

// V.x is a discovery tag and a tag is only injective when y is even, so walk a counter to an even-y point.
const MAX_VIEW_ROLL = 256n;

export interface GroupViewKey {
  readonly v: Fr;
  readonly V: Point<bigint>;
  /** The counter that produced an even-y V. Derived, so it never has to travel. */
  readonly roll: bigint;
}

/**
 * @deprecated Derives `v` from the CALLING member's own personal view key, so every non-creator member
 * gets a DIFFERENT `v` (and `V`) for the same group -- there is no single canonical `(gpk, V)` receiving
 * address a treasury can publish, because reconstructing it requires the creator's specific account.
 * Kept only for the existing simulation call sites (`unsafe-sim/`) that still pass a single `creator`.
 * Use `deriveGroupViewKeyFromSecret` with a `gvs` from `tss/groupSecret.ts`'s
 * `combineGroupViewContributions` instead: every member who ran the same DKG round-2 contribution
 * exchange computes the identical `gvs`, and therefore the identical `(v, V)`.
 */
export async function deriveGroupViewKey(
  account: IDarkAccount,
  gpk: Point<bigint>,
): Promise<GroupViewKey> {
  const skView = await account.getViewKey();
  for (let roll = 0n; roll < MAX_VIEW_ROLL; roll++) {
    const salt = await Poseidon.hash([
      new Fr(gpk[0]),
      new Fr(gpk[1]),
      new Fr(roll),
    ]);
    const v = toBjjScalar(await Kdf.derive(MS_VIEW_LABEL, skView, salt));
    const V = publicKey(v);
    if (isEvenY(V)) return { v, V, roll };
  }
  throw new Error(
    `group view key: no even-y V within ${MAX_VIEW_ROLL} rolls for this group`,
  );
}

/**
 * The canonical replacement for `deriveGroupViewKey`: derives `(v, V)` from the group-shared view secret
 * `gvs` (see `tss/groupSecret.ts`'s `combineGroupViewContributions`) instead of any one member's personal
 * account. Every member who combined the same set of DKG round-2 contributions computes the same `gvs`,
 * and therefore the same `(v, V)` here -- giving the treasury one canonical receiving address every member
 * can reconstruct and scan for, independent of who "created" the group.
 *
 * Same even-y rolling as `deriveGroupViewKey`: `V.x` is a discovery tag, and a tag is only injective when
 * `V`'s y-coordinate is even, so the roll counter walks forward until it lands on one.
 */
export async function deriveGroupViewKeyFromSecret(
  gvs: Fr,
  gpk: Point<bigint>,
): Promise<GroupViewKey> {
  for (let roll = 0n; roll < MAX_VIEW_ROLL; roll++) {
    const salt = await Poseidon.hash([
      new Fr(gpk[0]),
      new Fr(gpk[1]),
      new Fr(roll),
    ]);
    const v = toBjjScalar(await Kdf.derive(MS_VIEW_LABEL, gvs, salt));
    const V = publicKey(v);
    if (isEvenY(V)) return { v, V, roll };
  }
  throw new Error(
    `group view key: no even-y V within ${MAX_VIEW_ROLL} rolls for this group`,
  );
}
