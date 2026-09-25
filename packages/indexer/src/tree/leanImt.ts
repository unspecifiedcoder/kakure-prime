import { hash3 } from "./poseidonV1.js";

/**
 * LeanIMT mirror maintained by the indexer, per I-5: depth 32, frontier insert identical to
 * the reference EVM implementation's `MerkleTreeLib.sol` / the pool's on-chain insert algorithm, `node =
 * poseidon_v1([left, right, level])`, zero sibling passes through (no hashing with an empty
 * subtree — the non-zero side is carried up unchanged).
 *
 * Stores every level's frontier and full leaf-level history so it can serve `GET /path/:leaf_index`
 * sibling paths for any previously inserted leaf (I-8), not just the current frontier.
 *
 * TODO(integration): swap this for `@kakure/sdk`'s LeanIMT (workstream C) once published, so the
 * tree implementation is not duplicated across packages. Keep the KAT
 * (`circuits/kat/lean_imt_poseidon_v1.json`, workstream A) as the cross-check when swapping.
 */
export class LeanIMT {
  /** levels[0] = leaves, levels[i] = level-i nodes, in insertion order. */
  private readonly levels: bigint[][];
  private nextIndex = 0;
  private root = 0n;

  constructor(public readonly depth: number = 32) {
    if (depth < 1 || depth > 32) {
      throw new Error("depth must be between 1 and 32");
    }
    this.levels = Array.from({ length: depth + 1 }, () => []);
  }

  get nextLeafIndex(): number {
    return this.nextIndex;
  }

  getRoot(): bigint {
    return this.root;
  }

  /** Frontier insert: walk levels 0..depth, even index stores and stops, odd index hashes up. */
  insert(leaf: bigint): bigint {
    if (leaf === 0n) {
      throw new Error("leaf must be non-zero");
    }
    const capacity = 2n ** BigInt(this.depth);
    if (BigInt(this.nextIndex) >= capacity) {
      throw new Error("tree is full");
    }

    const leafIndex = this.nextIndex;
    this.levels[0]![leafIndex] = leaf;
    this.nextIndex++;

    let node = leaf;
    let indexAtLevel = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const siblingIndex = indexAtLevel % 2 === 0 ? indexAtLevel + 1 : indexAtLevel - 1;
      const sibling = this.levels[level]?.[siblingIndex] ?? 0n;

      const left = indexAtLevel % 2 === 0 ? node : sibling;
      const right = indexAtLevel % 2 === 0 ? sibling : node;

      let parent: bigint;
      if (left === 0n && right === 0n) {
        parent = 0n;
      } else if (right === 0n) {
        parent = left; // zero sibling passes through
      } else if (left === 0n) {
        parent = right; // zero sibling passes through
      } else {
        parent = hash3(left, right, BigInt(level));
      }

      const parentIndex = Math.floor(indexAtLevel / 2);
      this.levels[level + 1]![parentIndex] = parent;

      node = parent;
      indexAtLevel = parentIndex;
    }

    this.root = node;
    return node;
  }

  /** Sibling path for a previously inserted leaf, padded with 0n for levels beyond the frontier. */
  getPath(leafIndex: number): bigint[] {
    if (leafIndex < 0 || leafIndex >= this.nextIndex) {
      throw new Error("leaf index out of bounds");
    }
    const path: bigint[] = [];
    let indexAtLevel = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const siblingIndex = indexAtLevel % 2 === 0 ? indexAtLevel + 1 : indexAtLevel - 1;
      path.push(this.levels[level]?.[siblingIndex] ?? 0n);
      indexAtLevel = Math.floor(indexAtLevel / 2);
    }
    return path;
  }
}
