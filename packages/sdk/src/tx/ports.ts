/**
 * The ports transaction assembly depends on.
 *
 * Every one is an interface the CONSUMER implements, never a class this package constructs. That is not
 * style: `@kakure/prover` depends on `@kakure/sdk`, so the sdk importing the prover would be a cycle, and no
 * single backend serves node, a browser, an MV3 extension, mobile and a relayer at once.
 *
 * Ported from the reference EVM implementation's wallets package/src/tx/ports.ts. `ChainView`, `NoteSource`, `NoteLease` and
 * `EntropySource` are unchanged (they were already chain-agnostic by design -- see the `ChainView` comment
 * below). `CircuitId`, `ProofData`/`ProverPort` are replaced: the reference EVM implementation's `CircuitId` was a string union over
 * the EVM circuit set (including `swap_intent`/`swap_settle`, out of Kakure v1's scope); Kakure's circuits
 * are numbered per the master plan's frozen interface I-1, and the prover's output type is I-6's
 * `ProofBundle`, not the older `ProofData`.
 */
import { Fr } from "@aztec/foundation/fields";
import { Point } from "@zk-kit/baby-jubjub";

/** I-1: circuit ids and public-input layouts, in the frozen order. */
export enum CircuitId {
  Deposit = 0,
  Transfer = 1,
  Withdraw = 2,
  TransferMultisig = 3,
  SplitMultisig = 4,
  JoinMultisig = 5,
  WithdrawMultisig = 6,
}

/** I-1: expected flat public-input count per circuit, indexed by `CircuitId`. */
export const PUBLIC_INPUT_COUNT: Readonly<Record<CircuitId, number>> = {
  [CircuitId.Deposit]: 13,
  [CircuitId.Transfer]: 24,
  [CircuitId.Withdraw]: 17,
  [CircuitId.TransferMultisig]: 24,
  [CircuitId.SplitMultisig]: 22,
  [CircuitId.JoinMultisig]: 14,
  [CircuitId.WithdrawMultisig]: 17,
};

/**
 * I-6: the prover's (workstream D) output type, consumed here by `TxBuilder` and by workstreams E/F.
 * `publicInputs` is the flat `Field[]` from I-1, each entry 32-byte big-endian canonical (< BN254 scalar
 * modulus) -- Sunspot's `.pw` public-witness file is the source of truth; the prover converts it to this
 * shape, UNCHANGED by workstream G (still the full I-1 layout, `cpk_x`/`cpk_y`/`root` included --
 * `TxBuilder` is the one that strips those out and resolves a `root_index` per spend circuit before
 * writing the on-chain wire format; see `programs/kakure_pool/src/instruction.rs`'s module docs).
 *
 * `proof` is the COMPRESSED 192-byte Groth16 proof (`A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖
 * commitment_pok(32)`) as of workstream G -- `@kakure/prover`'s `prove()` compresses the raw uncompressed
 * `.proof` bytes (`compressProof`, `packages/prover/src/compress.ts`) before returning this type,
 * precisely so `@kakure/sdk` never needs to depend on `@kakure/prover` to build the compressed wire format
 * (see this file's own doc comment on the dependency direction, above). `TxBuilder` writes it straight
 * through as a fixed `[u8; 192]`; a `ProofBundle` built by hand (tests, fixtures) must supply an
 * already-compressed 192-byte `proof`.
 */
export interface ProofBundle {
  readonly circuitId: CircuitId;
  readonly proof: Uint8Array;
  readonly publicInputs: readonly Uint8Array[];
}

/**
 * Proving. ALWAYS LOCAL.
 *
 * The witness contains the owner's BabyJubJub spend scalar in clear, so an implementation that ships the
 * witness anywhere off-device is a total custody break, not a performance trade. This port exists so each
 * environment can supply its own LOCAL backend, never to offload the work. Kakure's proving path
 * (`noir_js` witness -> `sunspot prove`) lives in `@kakure/prover`; this package only depends on the
 * resulting shape.
 */
export interface ProverPort {
  capabilities(): Promise<{
    readonly circuits: readonly CircuitId[];
    readonly environment: "native" | "wasm";
  }>;
  prove(
    circuit: CircuitId,
    inputs: Record<string, unknown>,
  ): Promise<ProofBundle>;
}

/**
 * Where a spend's Merkle witness comes from.
 *
 * Keyed by the LEAF, not by an index: `pathFor(leafIndex)` would hand the provider the exact position of
 * the note you are about to spend, which is the one thing a private-retrieval layer exists to hide.
 *
 * It needs NO TRUST. Roots are retained in the pool's 256-entry ring buffer, so any root still in the ring
 * is provable against; and because `leaf_index` is uniquely determined by (leaf, root), a wrong or
 * malicious witness can only make a proof FAIL, never make it prove something false. Callers must still
 * verify: recompute the root locally and check it is known on chain (or accept `StaleRoot` and re-prove).
 */
export interface MerkleWitnessSource {
  witnessFor(leaf: Fr): Promise<{
    readonly leafIndex: number;
    readonly siblings: readonly Fr[];
    readonly root: Fr;
  }>;
}

/** The chain reads assembly needs, and nothing else. Keeps `@solana/web3.js` out of this file. */
export interface ChainView {
  isKnownRoot(root: Fr): Promise<boolean>;
  /** `(x, y, version)`. The version is the anchor: a rotation mid-flight invalidates an in-progress build. */
  complianceKey(): Promise<{
    readonly point: Point<bigint>;
    readonly version: number;
  }>;
  nextLeafIndex(): Promise<number>;
}

/** Read-only view of spendable notes. Async so IndexedDB, chrome.storage and sqlite all satisfy it. */
export interface NoteSource {
  unspent(assetId?: Fr): Promise<
    readonly {
      readonly leafIndex: number;
      readonly assetId: Fr;
      readonly value: bigint;
    }[]
  >;
}

/**
 * Exclusive claim on a note for the duration of an assembly.
 *
 * Two devices under one seed will otherwise select the same note, and the loser burns a proof and an
 * ephemeral index. The lease is durable because the losing device may be the one that crashes.
 */
export interface NoteLease {
  acquire(leafIndices: readonly number[], planId: string): Promise<boolean>;
  release(planId: string): Promise<void>;
}

/**
 * Randomness, injected rather than ambient so a test can pin it and an audit can find it.
 *
 * `nextMemoEphemeral` is a SAMPLER, not a value: the memo ephemeral is rejection-sampled until its public
 * key has even y, so handing back one fixed scalar makes that loop non-terminating.
 */
export interface EntropySource {
  nextMemoEphemeral(): Fr;
  salt(): Fr;
}
