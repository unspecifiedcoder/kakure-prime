import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { LeanIMT } from "../merkle/LeanIMT.js";
import { toFr } from "../crypto/fields.js";
import { poseidonV1Hash3 } from "../crypto/PoseidonV1.js";

// Master plan I-5 / spec §3.1: the tree's node hash moved from Poseidon2 to Poseidon v1 (circom/BN254
// params), so the reference EVM implementation's hardcoded Poseidon2 KAT roots for this file no longer apply. They were dropped
// when this file was ported (see docs/superpowers/plans/2026-09-05-ws-c-sdk.md step 3).
// `circuits/kat/lean_imt_poseidon_v1.json` (workstream A's authoritative fixture) did not exist in the
// `a-circuits` worktree as of this port -- `PoseidonV1.test.ts` covers the reconciliation flag for that.
//
// What this file verifies instead: `LeanIMT`'s frontier-insert algorithm (which only ever touches
// `O(depth)` per-level state) produces the SAME root as a naive from-scratch rebuild of the full binary
// tree at every level (which materialises every node), for a range of leaf counts that exercise every
// parity of "is this level's node count odd or even" up to depth 6. The frontier algorithm's whole point is
// to be equivalent to the naive one while being cheaper; this is a direct proof of that equivalence against
// `poseidonV1Hash3`, independent of any hardcoded constant.
const DEPTH = 32;

async function frontierTreeOf(n: number): Promise<LeanIMT> {
  const t = new LeanIMT(DEPTH);
  for (let i = 1; i <= n; i++) await t.insert(toFr(BigInt(i)));
  return t;
}

/** Naive full-rebuild reference: mirrors the LeanIMT rule (zero-sibling passthrough, `H(l,r,level)`
 *  otherwise) but recomputes every level from scratch rather than keeping frontier state. */
async function naiveRoot(n: number, depth: number): Promise<Fr> {
  const zero = new Fr(0n);
  let level: Fr[] = Array.from({ length: n }, (_, i) => toFr(BigInt(i + 1)));
  for (let lvl = 0; lvl < depth; lvl++) {
    const next: Fr[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : zero;
      if (left.equals(zero) && right.equals(zero)) {
        next.push(zero);
      } else if (right.equals(zero)) {
        next.push(left);
      } else if (left.equals(zero)) {
        next.push(right);
      } else {
        next.push(await poseidonV1Hash3(left, right, new Fr(BigInt(lvl))));
      }
    }
    level = next;
  }
  return level[0]!;
}

describe("LeanIMT frontier insert vs naive rebuild (Poseidon v1)", () => {
  for (const n of [1, 2, 3, 8, 16, 17, 33, 40]) {
    it(`root for n=${n} leaves matches a from-scratch rebuild`, async () => {
      const frontier = await frontierTreeOf(n);
      const naive = await naiveRoot(n, DEPTH);
      expect(frontier.getRoot().toString()).toBe(naive.toString());
    });
  }

  it("getMerklePath returns a full depth-32 path at a deep index", async () => {
    const t = await frontierTreeOf(40);
    expect(t.getMerklePath(39).length).toBe(DEPTH);
  });

  it("a Merkle path folds back to the tree's root (foldPath-equivalent, inline)", async () => {
    const t = await frontierTreeOf(17);
    const leafIndex = 5;
    const leaf = toFr(BigInt(leafIndex + 1));
    const siblings = t.getMerklePath(leafIndex);
    let current = leaf;
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i]!;
      const bit = (BigInt(leafIndex) >> BigInt(i)) & 1n;
      if (sibling.toBigInt() === 0n) {
        if (bit === 1n) throw new Error("non-canonical index");
        continue;
      }
      const left = bit === 1n ? sibling : current;
      const right = bit === 1n ? current : sibling;
      current = await poseidonV1Hash3(left, right, toFr(BigInt(i)));
    }
    expect(current.toString()).toBe(t.getRoot().toString());
  });
});
