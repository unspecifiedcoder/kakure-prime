// `merkle/genesis.ts`'s `genesisLeaf` already takes a generic `genesisHash: bigint` (spec §3.5: the
// cluster's genesis hash replaces the reference EVM implementation's EVM `chainId`), so there is nothing Solana-specific left to
// add here beyond a convenience re-export at the `solana/` barrel.
export { genesisLeaf, newSeededTree, TREE_DEPTH } from "../merkle/genesis.js";
