// keccak256(label) % BN254_Fr; MUST match Noir shared/src/common/domains.nr byte-for-byte.

/** keccak256("kakure.frost.v1"). */
export const SCHNORR_DOMAIN =
  0xc226e4b2bad84dcd0be5f5cc5c4334b8906fc9057331061d0b5b6117c74c667n;

/** keccak256("kakure.frost.rho.v1"). */
export const FROST_RHO_DOMAIN =
  0x14d965d53f58e0d5753aa0dfa8def0c242fd638f6278452e72189ace62f2d5ddn;

/** keccak256("kakure.frost.nonce.v1"). */
export const FROST_NONCE_DOMAIN =
  0x6faa2a7a4934ae04655b2c2ad065be999db3e7558efb4c5773dcb0049d171c1n;

/** keccak256("kakure.frost.msg.v1"). */
export const FROST_MSG_DOMAIN =
  0xbcc548ac662c18acfe3a7e55819b50f625844f6970073879a345c4e72b9a5b3n;

/** keccak256("kakure.frost.com.v1"). */
export const FROST_COM_DOMAIN =
  0xcbf15304e113ef84855f7f50023246fd9dbfe5f507d30bf4ef95a4c2a4915d4n;

/** keccak256("kakure.frost.pop.v1"). */
export const FROST_POP_DOMAIN =
  0x209e21dad378253bec05dec69c0ba1062a1318dee1fc00b7c6060603abe6db36n;

/** keccak256("kakure.cp.v1"). */
export const CP_DOMAIN =
  0x23dabeda201c754f067d138365d1246df58773cc4ba056f4d1ef0c4a5d29c480n;

/** keccak256("kakure.frost.action.<op>.v1"); distinct per op to stop cross-op signature replay. */
export const ACTION_WITHDRAW =
  0x61c32c849432c5cb181c8aff85b048edfe720f4d14f9330a19892e6b3f2858en;
export const ACTION_TRANSFER =
  0x1547047254eb19dda78a0a366ebb6a91dc073c5396d00f1d32a4afbea2ca1b5dn;
export const ACTION_SPLIT =
  0xda9aecde0fd0366b1cc6070cd943bffd9cdc2bece458fe66a67881019937b18n;
export const ACTION_JOIN =
  0x8d2a589888a5903aeb21e14836db1b3d9adb31de0dd29fb5103978815f30223n;

/** keccak256("kakure.group.view.v1"). Domain-separates the group-shared view secret (`gvs`, see
 *  `tss/groupSecret.ts`) from every other Poseidon2 input in this file. */
export const GROUP_VIEW_DOMAIN =
  0x2a9e6844948f649c36de66fbbbbdb35c175af01c06598ea5a99f5761ff213d04n;
