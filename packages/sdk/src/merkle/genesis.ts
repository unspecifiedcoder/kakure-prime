import { Fr } from "@aztec/foundation/fields";
import { keccak_256 } from "@noble/hashes/sha3";
import { Poseidon } from "../crypto/Poseidon.js";
import { toReducedFr } from "../crypto/fields.js";
import { LeanIMT } from "./LeanIMT.js";

// Ported from the reference EVM implementation's wallets package/src/merkle/genesis.ts. Two changes from the EVM version (spec §3.5):
//   1. `chainId` -> `genesisHash`: the cluster's genesis hash is Solana's analogue of an EVM chain id, and
//      is what the pool program's `initialize` instruction actually seeds the tree with.
//   2. `keccak256` via `ethers` -> `@noble/hashes/sha3`'s `keccak_256`: same algorithm, no EVM dependency.
// `GENESIS_DOMAIN` and the Poseidon2 composition are byte-identical to the reference EVM implementation's, per I-5: only the tree's
// NODE hash moves to Poseidon v1 (see merkle/LeanIMT.ts) -- the genesis leaf itself stays Poseidon2.
const GENESIS_DOMAIN = "kakure.genesis";

/** Frozen with the on-chain tree: MUST equal `TREE_DEPTH` in `kakure_pool`. */
export const TREE_DEPTH = 32;

function keccak256Utf8(text: string): bigint {
  const digest = keccak_256(new TextEncoder().encode(text));
  return BigInt(
    "0x" + Buffer.from(digest).toString("hex"),
  );
}

/**
 * Byte-identical composition to `the pool contract._genesisLeaf()`: Poseidon2(keccak256(GENESIS_DOMAIN) reduced mod
 * the BN254 scalar field, genesisHash reduced mod the BN254 scalar field).
 *
 * `genesisHash` is REQUIRED: it is the tree's cross-cluster replay defence (localnet vs devnet vs mainnet),
 * so a default would let a wallet build a tree whose every root silently disagrees with the pool it talks to.
 *
 * `genesisHash` is reduced (`toReducedFr`), not merely field-checked (`toFr`): the reference EVM implementation's original caller
 * always passed an EVM chain id (a small integer, always far below the field modulus, so `toFr`'s strict
 * range check never fired there). Kakure's port swapped that for Solana's cluster genesis hash -- a
 * uniformly random 256-bit value per `Connection.getGenesisHash()` -- which is virtually always >= the
 * ~254-bit BN254 modulus. `toFr` would then throw on essentially every real genesis hash. `toReducedFr`
 * produces the identical `Fr` for any value that was already in range (so this changes nothing for the
 * old EVM chain-id callers or existing golden vectors), and additionally wraps values >= the modulus
 * instead of throwing -- exactly what a genuinely 256-bit input needs.
 */
export async function genesisLeaf(genesisHash: bigint): Promise<Fr> {
  const domainTag = keccak256Utf8(GENESIS_DOMAIN);
  return Poseidon.hash([toReducedFr(domainTag), toReducedFr(genesisHash)]);
}

/** A LeanIMT seeded exactly as the pool seeds it: genesis at index 0, so real notes start at index 1. */
export async function newSeededTree(genesisHash: bigint): Promise<LeanIMT> {
  const tree = new LeanIMT(TREE_DEPTH);
  await tree.insert(await genesisLeaf(genesisHash));
  return tree;
}
