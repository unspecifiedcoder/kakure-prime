/**
 * Decoder for the `Pool` account's raw byte layout (programs/kakure_pool/src/state.rs, I-2).
 *
 * `kakure_pool` is a native `solana-program` crate: `Pool` is a hand-rolled, fixed-offset,
 * zero-copy-style layout operated on directly over the raw account bytes -- there is no Anchor
 * 8-byte account discriminator prefix, and no borsh framing at all. `decodePool` mirrors
 * `state.rs`'s `Pool` field accessors exactly (same offsets, same field order), so a client can
 * read pool state (roots ring, next_leaf_index, verifiers, compliance key) directly from
 * `getAccountInfo`/`getAccountInfoAndContext` without depending on the indexer.
 */
import { PublicKey } from "@solana/web3.js";

export const TREE_DEPTH = 32;
export const ROOT_RING = 256;
export const NUM_VERIFIERS = 7;

const OFF_AUTHORITY = 0;
const OFF_PAUSED = 32;
const OFF_COMPLIANCE_VERSION = 33;
const OFF_COMPLIANCE_PK_X = 37;
const OFF_COMPLIANCE_PK_Y = 69;
const OFF_VERIFIERS = 101;
const OFF_NEXT_LEAF_INDEX = OFF_VERIFIERS + NUM_VERIFIERS * 32; // 325
const OFF_SIDE_NODES = OFF_NEXT_LEAF_INDEX + 8; // 333
const OFF_ROOT_CURSOR = OFF_SIDE_NODES + TREE_DEPTH * 32; // 1357
const OFF_ROOTS = OFF_ROOT_CURSOR + 1; // 1358
export const POOL_LEN = OFF_ROOTS + ROOT_RING * 32; // 9550

export interface PoolAccount {
  readonly authority: PublicKey;
  readonly paused: boolean;
  readonly complianceVersion: number;
  readonly compliancePkX: Uint8Array;
  readonly compliancePkY: Uint8Array;
  readonly verifiers: readonly PublicKey[];
  readonly nextLeafIndex: bigint;
  readonly sideNodes: readonly Uint8Array[];
  readonly rootCursor: number;
  readonly roots: readonly Uint8Array[];
}

function slice32(data: Uint8Array, offset: number): Uint8Array {
  return data.subarray(offset, offset + 32);
}

/**
 * Decodes a `Pool` account's raw data. Throws if `data.length !== POOL_LEN` (9550 bytes) --
 * the same fixed-length check `state.rs`'s `Pool::new` makes.
 */
export function decodePool(data: Uint8Array): PoolAccount {
  if (data.length !== POOL_LEN) {
    throw new Error(`decodePool: expected ${POOL_LEN} bytes, got ${data.length}`);
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const authority = new PublicKey(slice32(buf, OFF_AUTHORITY));
  const paused = buf[OFF_PAUSED] !== 0;
  const complianceVersion = buf.readUInt32LE(OFF_COMPLIANCE_VERSION);
  const compliancePkX = slice32(buf, OFF_COMPLIANCE_PK_X);
  const compliancePkY = slice32(buf, OFF_COMPLIANCE_PK_Y);

  const verifiers: PublicKey[] = [];
  for (let i = 0; i < NUM_VERIFIERS; i++) {
    verifiers.push(new PublicKey(slice32(buf, OFF_VERIFIERS + i * 32)));
  }

  const nextLeafIndex = buf.readBigUInt64LE(OFF_NEXT_LEAF_INDEX);

  const sideNodes: Uint8Array[] = [];
  for (let level = 0; level < TREE_DEPTH; level++) {
    sideNodes.push(slice32(buf, OFF_SIDE_NODES + level * 32));
  }

  const rootCursor = buf[OFF_ROOT_CURSOR]!;

  const roots: Uint8Array[] = [];
  for (let i = 0; i < ROOT_RING; i++) {
    roots.push(slice32(buf, OFF_ROOTS + i * 32));
  }

  return {
    authority,
    paused,
    complianceVersion,
    compliancePkX,
    compliancePkY,
    verifiers,
    nextLeafIndex,
    sideNodes,
    rootCursor,
    roots,
  };
}

/** `true` iff `root` (32 bytes) is present anywhere in the pool's 256-entry root ring buffer,
 *  mirroring `state.rs`'s `Pool::is_known_root`. */
export function isKnownRoot(pool: PoolAccount, root: Uint8Array): boolean {
  if (root.length !== 32) {
    throw new Error(`isKnownRoot: root must be 32 bytes, got ${root.length}`);
  }
  return pool.roots.some((r) => Buffer.compare(Buffer.from(r), Buffer.from(root)) === 0);
}

/**
 * Resolves `root` (32 bytes) to a `root_index` into the pool's 256-entry ring buffer -- the index
 * every spend instruction now carries instead of the 32-byte root itself (workstream G, see
 * `programs/kakure_pool/src/instruction.rs`'s module docs: `processor.rs`'s `resolve_root` reads
 * `pool.roots[root_index]` directly and rejects a never-written [zero] slot with `StaleRoot`).
 *
 * Searches walking BACKWARD from `rootCursor` (the most recently written slot) so that if a root
 * happens to appear more than once in the ring (extremely unlikely for a real Merkle root, but not
 * impossible if the tree's state repeats), the freshest occurrence wins -- the one least likely to
 * be overwritten by the time the built transaction lands.
 *
 * Returns `undefined` (never throws) if `root` is not present anywhere in the ring: the caller
 * (typically a spend builder) is expected to turn that into a clear, circuit-specific error rather
 * than a generic "not found" one produced here.
 */
export function rootIndexFor(pool: PoolAccount, root: Uint8Array): number | undefined {
  if (root.length !== 32) {
    throw new Error(`rootIndexFor: root must be 32 bytes, got ${root.length}`);
  }
  const target = Buffer.from(root);
  for (let step = 0; step < ROOT_RING; step++) {
    const idx = (pool.rootCursor - 1 - step + ROOT_RING * 2) % ROOT_RING;
    if (Buffer.compare(Buffer.from(pool.roots[idx]!), target) === 0) return idx;
  }
  return undefined;
}
