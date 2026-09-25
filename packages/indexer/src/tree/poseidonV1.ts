import { poseidon2, poseidon3 } from "poseidon-lite";

/**
 * Poseidon v1 (circom parameters), the hash the tree uses per I-5:
 * `node = poseidon_v1([left, right, level])` — Solana's `sol_poseidon` syscall, BN254,
 * big-endian field encoding on the wire. `poseidon-lite` implements the same circom-compatible
 * permutation used by `circomlibjs`, so it is the correct TS-side counterpart here.
 *
 * TODO(integration): swap this module for `@kakure/sdk`'s LeanIMT hash once workstream C
 * publishes it, so the tree implementation is not duplicated across packages.
 */

/** BN254 scalar field modulus. */
export const BN254_SCALAR_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Decode a big-endian 32-byte hex string (`0x`-prefixed or not) into a field element bigint. */
export function fieldFromHex(hex: string): bigint {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length === 0) return 0n;
  const value = BigInt(`0x${clean}`);
  if (value >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error(`field value ${value} is not canonical (>= BN254 scalar modulus)`);
  }
  return value;
}

/** Encode a field element bigint as a big-endian 32-byte `0x`-prefixed hex string. */
export function fieldToHex(value: bigint): string {
  if (value < 0n || value >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error(`field value ${value} is not a canonical BN254 scalar`);
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** `poseidon_v1([left, right, level])`, the LeanIMT node hash (I-5). */
export function hash3(left: bigint, right: bigint, level: bigint): bigint {
  return poseidon3([left, right, level]);
}

/** `poseidon_v1([a, b])`, exposed for cases needing a 2-input hash (e.g. genesis leaf variants). */
export function hash2(a: bigint, b: bigint): bigint {
  return poseidon2([a, b]);
}
