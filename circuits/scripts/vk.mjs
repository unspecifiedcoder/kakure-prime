/**
 * Minimal parser for Sunspot/gnark's raw `.vk` wire format (`WriteRawTo`), just enough to extract
 * the per-public-input Groth16 linear-combination points `K[i]` (gnark's "IC" vector). Layout,
 * read big-endian throughout, cross-checked against `/root/sunspot/gnark-solana/crates/
 * verifier-lib/src/vk.rs::parse_vk` (slice-2 F-1):
 *
 *   alpha_g1   [64]        (G1, uncompressed)
 *   beta_g1    [64]        (G1, uncompressed -- read by gnark's parser and discarded)
 *   beta_g2    [128]       (G2, uncompressed)
 *   gamma_g2   [128]
 *   delta_g1   [64]        (discarded)
 *   delta_g2   [128]
 *   ic_count   u32 BE
 *   ic[ic_count] * [64]    -- gnark's "IC"/vk.K: K[0] is the constant-term point; K[1..] are one
 *                              per public input (in circuit declaration order), followed by one
 *                              per PLONK-style commitment wire (if any).
 *   committed_matrix: outer_len u32 BE, then per row: inner_len u32 BE, inner_len * u64 BE
 *   nb_commitment_keys u32 BE
 *   commitment_keys[nb_commitment_keys] * [256]
 *
 * `nr_pubinputs = ic_count - 1 - nb_commitment_keys` (vk.rs), so the public-input points are
 * exactly `ic[1 .. 1 + nr_pubinputs]`.
 */

/** A 64-byte G1 point is the point at infinity in this wire format iff every byte is zero. */
export function isG1Infinity(point) {
  if (point.length !== 64) throw new Error(`expected a 64-byte G1 point, got ${point.length}`);
  return point.every((b) => b === 0);
}

export function parseGnarkVk(buf) {
  let off = 0;
  const take = (n) => {
    if (off + n > buf.length) throw new Error(`vk truncated: need ${n} bytes at ${off}, have ${buf.length}`);
    const slice = buf.subarray(off, off + n);
    off += n;
    return slice;
  };
  const u32 = () => {
    const v = take(4);
    return (v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3];
  };

  const alphaG1 = take(64);
  take(64); // beta_g1, discarded (matches vk.rs)
  const betaG2 = take(128);
  const gammaG2 = take(128);
  take(64); // delta_g1, discarded
  const deltaG2 = take(128);

  const icCount = u32();
  const ic = [];
  for (let i = 0; i < icCount; i++) ic.push(take(64));

  const outerLen = u32();
  for (let i = 0; i < outerLen; i++) {
    const innerLen = u32();
    take(innerLen * 8);
  }

  const nbCommitmentKeys = u32();
  for (let i = 0; i < nbCommitmentKeys; i++) take(256);

  const nrPubInputs = icCount - 1 - nbCommitmentKeys;
  if (nrPubInputs < 0) {
    throw new Error(`vk: nr_pubinputs computed negative (ic=${icCount}, commitmentKeys=${nbCommitmentKeys})`);
  }
  const publicInputK = ic.slice(1, 1 + nrPubInputs);

  return { alphaG1, betaG2, gammaG2, deltaG2, ic, nrPubInputs, publicInputK };
}
