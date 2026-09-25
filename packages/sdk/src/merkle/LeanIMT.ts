import { Fr } from "@aztec/foundation/fields";
import { poseidonV1Hash3 } from "../crypto/PoseidonV1.js";

// Ported from the reference EVM implementation's wallets package/src/merkle/LeanIMT.ts. Master plan I-5 / spec §3.1: the tree's
// node hash moves from Poseidon2 to Poseidon v1 (circom/BN254 params) so `kakure_pool` can recompute it
// on-chain with the `sol_poseidon` syscall. Structure (frontier insert, zero-sibling passthrough,
// canonical-index assert) is unchanged.

export class LeanIMT {
  private readonly zeroValue: Fr = new Fr(0n);
  public levels: Fr[][];
  public nextLeafIndex: number = 0;
  private currentRoot: Fr = new Fr(0n);

  constructor(public readonly depth: number) {
    if (depth < 1 || depth > 32) {
      throw new Error("Invalid depth");
    }
    this.levels = Array.from({ length: depth }, () => []);
  }

  public async insert(leaf: Fr): Promise<Fr> {
    if (leaf.equals(this.zeroValue)) {
      throw new Error("leaf must be non-zero");
    }
    const leafIndex = this.nextLeafIndex;
    const capacity = BigInt(2) ** BigInt(this.depth);
    if (BigInt(leafIndex) >= capacity) {
      throw new Error("Tree is full");
    }

    this.levels[0]!.push(leaf);
    this.nextLeafIndex++;

    let currentComputedNode = leaf;
    let currentIndexInLevel = leafIndex;

    for (let level = 0; level < this.depth; ++level) {
      // `level` ranges over [0, this.depth), and `this.levels` has exactly `this.depth` entries (see the
      // constructor), so `this.levels[level]` is always defined -- noUncheckedIndexedAccess cannot see
      // that invariant, hence the assertions below.
      const currentLevel = this.levels[level]!;
      const siblingIndex =
        currentIndexInLevel % 2 === 0
          ? currentIndexInLevel + 1
          : currentIndexInLevel - 1;
      const siblingNode =
        siblingIndex < currentLevel.length
          ? currentLevel[siblingIndex]!
          : this.zeroValue;

      const left =
        (currentIndexInLevel & 1) === 0 ? currentComputedNode : siblingNode;
      const right =
        (currentIndexInLevel & 1) === 0 ? siblingNode : currentComputedNode;

      if (left.equals(this.zeroValue) && right.equals(this.zeroValue)) {
        currentComputedNode = this.zeroValue;
      } else if (right.equals(this.zeroValue)) {
        currentComputedNode = left;
      } else if (left.equals(this.zeroValue)) {
        currentComputedNode = right;
      } else {
        currentComputedNode = await poseidonV1Hash3(
          left,
          right,
          new Fr(BigInt(level)),
        );
      }

      const parentIndex = Math.floor(currentIndexInLevel / 2);

      if (level < this.depth - 1) {
        const nextLevel = this.levels[level + 1]!;
        if (parentIndex >= nextLevel.length) {
          nextLevel.push(currentComputedNode);
        } else {
          nextLevel[parentIndex] = currentComputedNode;
        }
      }
      currentIndexInLevel = parentIndex;
    }

    this.currentRoot = currentComputedNode;
    return currentComputedNode;
  }

  public getRoot(): Fr {
    return this.currentRoot;
  }

  public getMerklePath(index: number): Fr[] {
    if (index >= this.nextLeafIndex) {
      throw new Error("Index out of bounds");
    }

    const path: Fr[] = [];
    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const siblingIndex =
        currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;

      const currentLevel = this.levels[level]!;
      if (siblingIndex < currentLevel.length) {
        path.push(currentLevel[siblingIndex]!);
      } else {
        path.push(this.zeroValue);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return path;
  }
}
