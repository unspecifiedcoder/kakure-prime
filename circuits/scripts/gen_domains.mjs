#!/usr/bin/env node
// Recomputes keccak256(label) % BN254_Fr for every Kakure domain-separator label.
//
// Usage: node circuits/scripts/gen_domains.mjs
// (must be run with a resolvable @noble/hashes -- e.g. from inside packages/sdk, or with
//  NODE_PATH pointed at a node_modules that has it)
//
// Prints a table of label -> 0x-prefixed hex (mod BN254_Fr), for pasting into:
//   - circuits/shared/src/common/domains.nr
//   - packages/sdk/src/crypto/constants.ts
//   - packages/sdk/src/tss/domains.ts

// Resolved via the sdk package's own dependency so this script needs no extra install step;
// run it from anywhere (it does not depend on process.cwd()).
const { createRequire } = await import("node:module");
const require = createRequire(
  new URL("../../packages/sdk/package.json", import.meta.url),
);
const { keccak_256 } = require("@noble/hashes/sha3.js");

const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function keccak256Utf8(label) {
  const digest = keccak_256(new TextEncoder().encode(label));
  return BigInt("0x" + Buffer.from(digest).toString("hex"));
}

export function domainOf(label) {
  return keccak256Utf8(label) % BN254_FR;
}

export function toHex(fr) {
  return "0x" + fr.toString(16);
}

const LABELS = [
  // Noir shared/src/common/domains.nr + TS crypto/constants.ts mirror
  "kakure.enc.v1",
  "kakure.psi.v1",
  // Noir SCHNORR_DOMAIN + TS tss/domains.ts SCHNORR_DOMAIN
  "kakure.frost.v1",
  // Noir ACTION_* + TS ACTION_* (per-op FROST message domains)
  "kakure.frost.action.withdraw.v1",
  "kakure.frost.action.transfer.v1",
  "kakure.frost.action.split.v1",
  "kakure.frost.action.join.v1",
  // TS-only tss/domains.ts (no Noir mirror -- off-chain FROST protocol domains)
  "kakure.frost.rho.v1",
  "kakure.frost.nonce.v1",
  "kakure.frost.msg.v1",
  "kakure.frost.com.v1",
  "kakure.frost.pop.v1",
  "kakure.cp.v1",
];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const label of LABELS) {
    const fr = domainOf(label);
    console.log(`${label}\t${toHex(fr)}`);
  }
}
