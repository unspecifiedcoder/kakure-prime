import { describe, expect, it } from "vitest";
import { LeanIMT } from "./leanImt.js";
import { hash3 } from "./poseidonV1.js";

describe("LeanIMT", () => {
  it("a single insert's root equals the leaf (zero sibling pass-through at every level)", () => {
    const tree = new LeanIMT(4);
    const leaf = 7n;
    const root = tree.insert(leaf);
    expect(root).toBe(leaf);
    expect(tree.getRoot()).toBe(leaf);
    expect(tree.nextLeafIndex).toBe(1);
  });

  it("two inserts hash at level 0 then pass zero through the remaining levels", () => {
    const tree = new LeanIMT(4);
    const leaf0 = 7n;
    const leaf1 = 9n;
    tree.insert(leaf0);
    const root = tree.insert(leaf1);
    const expected = hash3(leaf0, leaf1, 0n); // level 0 has both leaves; levels 1-3 are zero-sibling pass-through
    expect(root).toBe(expected);
  });

  it("three inserts: index 2 (even) stores at level 0, pairs with leaf 0/1's parent at level 1", () => {
    const tree = new LeanIMT(4);
    const leaf0 = 7n;
    const leaf1 = 9n;
    const leaf2 = 11n;
    tree.insert(leaf0);
    tree.insert(leaf1);
    const root = tree.insert(leaf2);
    const level0Parent = hash3(leaf0, leaf1, 0n);
    // leaf2 sits alone at level 0 index 2 (odd sibling index 3 is zero) -> passes through to level 1 index 1
    // level 1: index 0 = level0Parent, index 1 = leaf2 -> hash together at level 1
    const expected = hash3(level0Parent, leaf2, 1n);
    expect(root).toBe(expected);
  });

  it("getPath returns the sibling at each level, zero-padded beyond the frontier", () => {
    const tree = new LeanIMT(4);
    const leaf0 = 7n;
    const leaf1 = 9n;
    tree.insert(leaf0);
    tree.insert(leaf1);
    const path0 = tree.getPath(0);
    expect(path0).toEqual([leaf1, 0n, 0n, 0n]);
    const path1 = tree.getPath(1);
    expect(path1).toEqual([leaf0, 0n, 0n, 0n]);
  });

  it("rejects a zero leaf", () => {
    const tree = new LeanIMT(4);
    expect(() => tree.insert(0n)).toThrow();
  });

  it("rejects out-of-bounds getPath", () => {
    const tree = new LeanIMT(4);
    tree.insert(1n);
    expect(() => tree.getPath(1)).toThrow();
    expect(() => tree.getPath(-1)).toThrow();
  });

  it("depth-32 sanity: a single insert's root equals the leaf with 32 zero-sibling levels", () => {
    const tree = new LeanIMT(32);
    const leaf = 123456789n;
    const root = tree.insert(leaf);
    expect(root).toBe(leaf);
    const path = tree.getPath(0);
    expect(path).toHaveLength(32);
    expect(path.every((s) => s === 0n)).toBe(true);
  });
});
