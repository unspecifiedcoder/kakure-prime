import { ProofError } from "./errors.js";

/**
 * BN254's scalar field modulus (`Fr`) -- the field every circuit public input/witness value lives
 * in (as opposed to `Fq`, the base field G1/G2 coordinates live in -- see `compress.ts`'s
 * `FQ_MODULUS`). Standard BN254 `r`.
 */
const FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function beToBigIntFr(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * slice-2 F-9: `decodePublicWitness`/`encodePublicWitness` never checked that a public-input
 * entry is a canonical `Fr` element (`< FR_MODULUS`). Today every value comes from `sunspot
 * prove`'s own output, so an out-of-range value would already be rejected on-chain
 * (`GnarkError::PublicInputGreaterThanFieldSize`, see F-6) -- this is defence in depth, turning
 * that into a clear client-side error (`ProofError`) instead of silently shipping a non-canonical
 * value through the wire format.
 */
export function assertCanonicalFr(entry: Uint8Array, label: string): bigint {
  if (entry.length !== 32) {
    throw new ProofError("decode", `${label} must be exactly 32 bytes, got ${entry.length}`);
  }
  const v = beToBigIntFr(entry);
  if (v >= FR_MODULUS) {
    throw new ProofError("decode", `${label} is not a canonical Fr element (>= FR_MODULUS): ${v}`);
  }
  return v;
}

/**
 * Sunspot's `.pw` (public witness) byte layout (source: `gnark-solana/crates/verifier-lib/src/
 * witness.rs`'s `GnarkWitness::from_bytes`/`parse`, confirmed empirically against the committed
 * `transfer_multisig.pw` fixture -- see workstream D's report):
 *
 *   offset  size   field
 *   0       4      nr_public_inputs   (u32 BE)
 *   4       4      nr_private_inputs  (u32 BE, always 0 in a public witness)
 *   8       4      entries_count      (u32 BE, == nr_public_inputs)
 *   12      32*N   entries[0..N)      (N = nr_public_inputs, each 32-byte BE canonical Field, in
 *                                       I-1's flat order: `pub fn` params in signature order, then
 *                                       the `pub` return tuple flattened in order)
 */
export function decodePublicWitness(pw: Uint8Array): Uint8Array[] {
  if (pw.length < 12) {
    throw new ProofError("decode", `public witness too short: ${pw.length} bytes (need >= 12-byte header)`);
  }
  const view = new DataView(pw.buffer, pw.byteOffset, pw.byteLength);
  const nrPublic = view.getUint32(0, false);
  const nrPrivate = view.getUint32(4, false);
  const entriesCount = view.getUint32(8, false);
  if (nrPrivate !== 0) {
    throw new ProofError("decode", `expected a PUBLIC witness (nr_private_inputs == 0), got ${nrPrivate}`);
  }
  if (entriesCount !== nrPublic) {
    throw new ProofError(
      "decode",
      `entries_count (${entriesCount}) != nr_public_inputs (${nrPublic})`,
    );
  }
  const expectedLen = 12 + entriesCount * 32;
  if (pw.length !== expectedLen) {
    throw new ProofError(
      "decode",
      `public witness length ${pw.length} != 12 + ${entriesCount}*32 = ${expectedLen}`,
    );
  }
  const entries: Uint8Array[] = [];
  for (let i = 0; i < entriesCount; i++) {
    const offset = 12 + i * 32;
    const entry = pw.slice(offset, offset + 32);
    assertCanonicalFr(entry, `public witness entry ${i}`);
    entries.push(entry);
  }
  return entries;
}

/**
 * Sunspot's `.proof` byte layout (source: `gnark-solana/crates/verifier-lib/src/proof.rs`'s
 * `GnarkProof::from_bytes`, confirmed against the committed `transfer_multisig.proof` fixture,
 * 388 bytes / commitment_count=1):
 *
 *   offset     size    field
 *   0          64      A (G1 point, BN254)
 *   64         128     B (G2 point, BN254)
 *   192        64      C (G1 point, BN254)
 *   256        4       commitment_count (u32 BE) -- 1 for every v1 circuit
 *   260        64*M    commitments[0..M)
 *   260+64*M   64      commitment_pok
 */
export interface DecodedProof {
  readonly a: Uint8Array;
  readonly b: Uint8Array;
  readonly c: Uint8Array;
  readonly commitmentCount: number;
  readonly commitments: Uint8Array;
  readonly commitmentPok: Uint8Array;
}

export function decodeProof(proof: Uint8Array): DecodedProof {
  if (proof.length < 260) {
    throw new ProofError("decode", `proof too short: ${proof.length} bytes (need >= 260)`);
  }
  const view = new DataView(proof.buffer, proof.byteOffset, proof.byteLength);
  const commitmentCount = view.getUint32(256, false);
  const expectedLen = 260 + 64 * commitmentCount + 64;
  if (proof.length !== expectedLen) {
    throw new ProofError(
      "decode",
      `proof length ${proof.length} != 260 + 64*${commitmentCount} + 64 = ${expectedLen}`,
    );
  }
  const commitmentsEnd = 260 + 64 * commitmentCount;
  return {
    a: proof.slice(0, 64),
    b: proof.slice(64, 192),
    c: proof.slice(192, 256),
    commitmentCount,
    commitments: proof.slice(260, commitmentsEnd),
    commitmentPok: proof.slice(commitmentsEnd, commitmentsEnd + 64),
  };
}

/**
 * Re-encodes `publicInputs` (I-1's flat `Field[]`, each already 32-byte BE) back into the exact
 * `.pw` byte format Sunspot produces: 12-byte header (`nr_public_inputs`, `nr_private_inputs=0`,
 * `entries_count`, each u32 BE) followed by the entries. The verifier program's instruction-data
 * split (`gnark-solana/crates/verifier-bin/src/lib.rs`: `proof_len = data.len() - (12 +
 * NR_INPUTS*32)`) expects this header to be present in the "public witness" half, not stripped.
 */
export function encodePublicWitness(publicInputs: readonly Uint8Array[]): Uint8Array {
  const n = publicInputs.length;
  const out = new Uint8Array(12 + n * 32);
  const view = new DataView(out.buffer);
  view.setUint32(0, n, false);
  view.setUint32(4, 0, false);
  view.setUint32(8, n, false);
  for (let i = 0; i < n; i++) {
    const entry = publicInputs[i];
    if (!entry || entry.length !== 32) {
      throw new ProofError("encode", `public input ${i} must be exactly 32 bytes`);
    }
    assertCanonicalFr(entry, `public input ${i}`);
    out.set(entry, 12 + i * 32);
  }
  return out;
}

/**
 * The bytes the `kakure_pool` verifier program's CPI instruction data must be, per I-2 /
 * `gnark-solana/crates/verifier-bin/src/lib.rs`: `proof_bytes ‖ public_witness_bytes`
 * concatenated verbatim, where `public_witness_bytes` is the FULL `.pw` encoding (12-byte header
 * included) -- the on-chain split point is computed from the header-inclusive length, so omitting
 * the header would desynchronize the split and the parse.
 */
export function proofBytesForChain(bundle: { proof: Uint8Array; publicInputs: readonly Uint8Array[] }): Uint8Array {
  const pw = encodePublicWitness(bundle.publicInputs);
  const out = new Uint8Array(bundle.proof.length + pw.length);
  out.set(bundle.proof, 0);
  out.set(pw, bundle.proof.length);
  return out;
}
