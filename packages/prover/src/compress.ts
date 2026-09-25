import { ProofError } from "./errors.js";
import { decodeProof, type DecodedProof } from "./decode.js";

/**
 * BN254's base field modulus (`Fq`) -- the field G1/G2 coordinates live in. Ported from the
 * `solana-bn254` 3.1.2 crate's `compression.rs` (host/non-solana-target branch), which delegates
 * the actual
 * (de)compression to `ark-bn254`/`ark-ec`/`ark-serialize` 0.4.0's `CanonicalSerialize` for
 * `ark_ec::models::short_weierstrass::Affine<P>` -- this is that same modulus.
 */
const FQ_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** The compressed-point sign flag arkworks packs into the top bit of the serialized x-coordinate's
 * most-significant byte (see `ark-ec-0.4.2`'s `Affine::to_flags`/`SWFlags::YIsPositive`). BN254's Fq
 * modulus is a 254-bit number, so a canonical field element's 32-byte big-endian encoding never sets
 * either of the top 2 bits of byte 0 -- this flag bit can never collide with real coordinate data. */
const SIGN_FLAG_BIT = 0x80;

function beToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

/**
 * slice-2 F-9: every value handed to `fqSignFlagBit`/`fq2SignFlagBit` (and hence to `compressG1`/
 * `compressG2`) MUST be canonical (`< FQ_MODULUS`) -- `fqSignFlagBit`'s `(FQ_MODULUS - y) %
 * FQ_MODULUS` assumes it. Without this check a non-canonical `y >= FQ_MODULUS` makes
 * `FQ_MODULUS - y` negative, and JS `BigInt` `%` (unlike Python's) preserves the DIVIDEND's sign,
 * so the "negated" value comes back negative too -- the sign-flag comparison then runs on garbage
 * instead of throwing. Today every value reaching this module comes from `sunspot prove`'s own
 * output, so this is defence in depth (an out-of-range value would already be rejected on-chain,
 * see F-6); it turns a silent wrong-flag bug into a clear client-side error instead.
 */
function assertCanonicalFq(y: bigint, label: string): void {
  if (y < 0n || y >= FQ_MODULUS) {
    throw new ProofError("encode", `${label} is not a canonical Fq element (>= FQ_MODULUS or negative): ${y}`);
  }
}

/**
 * Whether the sign-flag bit (0x80) must be set for a base-field (`Fq`) `y` coordinate. Per
 * `ark-ec-0.4.2`'s `SWFlags` (`serialization_flags.rs`): `YIsPositive` (`y <= -y`) is encoded with
 * NO bits set, while `YIsNegative` (`y > -y`) sets bit 0x80 -- i.e. the flag bit is set exactly
 * when `y > -y`, comparing canonical big-integer representatives.
 */
function fqSignFlagBit(y: bigint): boolean {
  const negY = (FQ_MODULUS - y) % FQ_MODULUS;
  return y > negY;
}

/**
 * Whether the sign-flag bit (0x80) must be set for a quadratic-extension (`Fq2 = Fq[u]/(u^2+1)`)
 * `y` coordinate serialized here as two 32-byte big-endian halves `y0` (bytes `[0..32)`) and `y1`
 * (bytes `[32..64)`): set iff `y > -y`, comparing `(y0, y1)` lexicographically against
 * `(-y0, -y1)` -- `y0` (the FIRST serialized half) decides unless it ties, in which case `y1`
 * breaks the tie. See `fqSignFlagBit` for the bit-vs-comparison direction.
 *
 * WORKSTREAM G BUG FIX (found by a real e2e `deposit` proof failing on-chain with "Proof
 * verification failed!" -- see the git history on this function): an earlier version of this
 * compared `y1` first assuming `ark-ff`'s `QuadExtField::Ord` (`ark-ff-0.4.2`'s
 * `quadratic_extension.rs`, which orders `(c1, c0)`) applied directly to this wire layout. It does
 * NOT: `solana_bn254`'s G2 (de)compression serializes/deserializes the two Fq2 coordinate halves
 * in the OPPOSITE of `ark_ff::Fp2`'s own field-declaration order, so the half that decides the
 * comparison first is the one serialized FIRST here (`y0`), not second. The single-proof KAT
 * (`circuits/kat/proof_compression_kat.json`) this module is tested against happened to have
 * `y1 == -y1` (a tie on the WRONG primary component), which made the bug invisible there --
 * `compress.test.ts` now also asserts against a second, real e2e-captured KAT
 * (`circuits/kat/proof_compression_kat_deposit_g2_regression.json`) that does NOT tie, to catch a
 * regression like this one.
 */
function fq2SignFlagBit(y0: bigint, y1: bigint): boolean {
  const negY0 = (FQ_MODULUS - y0) % FQ_MODULUS;
  const negY1 = (FQ_MODULUS - y1) % FQ_MODULUS;
  if (y0 !== negY0) return y0 > negY0;
  return y1 > negY1;
}

/**
 * Compresses a BN254 G1 point given as a 64-byte big-endian `x(32) ‖ y(32)` pair into the 32-byte
 * compressed form: `x`, with the sign flag OR'd into the top bit of byte 0. Special-cases the
 * all-zero (point-at-infinity) encoding, matching `solana_bn254::compression`'s own shortcut (and
 * its on-chain decompression counterpart, which special-cases an all-zero COMPRESSED input the
 * same way).
 */
export function compressG1(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 64) {
    throw new ProofError("encode", `compressG1 expects a 64-byte G1 point, got ${uncompressed.length}`);
  }
  if (isAllZero(uncompressed)) return new Uint8Array(32);
  const x = uncompressed.slice(0, 32);
  const y = beToBigInt(uncompressed.slice(32, 64));
  assertCanonicalFq(beToBigInt(x), "G1.x");
  assertCanonicalFq(y, "G1.y");
  const out = x.slice();
  if (fqSignFlagBit(y)) out[0] = (out[0] ?? 0) | SIGN_FLAG_BIT;
  return out;
}

/**
 * Compresses a BN254 G2 point given as a 128-byte big-endian `x(64) ‖ y(64)` pair into the 64-byte
 * compressed form: `x` (64 bytes), with the sign flag OR'd into the top bit of byte 0.
 *
 * slice-2 F-9 doc nit: each 64-byte half is itself two 32-byte `Fq` limbs, but the wire order is
 * `c1(32) ‖ c0(32)` -- the OPPOSITE of `ark_ff::Fp2`'s own field-declaration order (`c0` then
 * `c1`). This is exactly why `fq2SignFlagBit(y0, y1)` below compares the FIRST serialized half
 * (`y0`, which is really `c1`) first: `solana_bn254`'s G2 (de)compression writes/reads the halves
 * reversed relative to `ark_ff::Fp2::CanonicalSerialize` (see that function's "WORKSTREAM G BUG
 * FIX" comment for the regression this caused). The code here has always been correct; only this
 * comment was previously wrong (it claimed `c0 ‖ c1` in `ark_ff`'s order).
 */
export function compressG2(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 128) {
    throw new ProofError("encode", `compressG2 expects a 128-byte G2 point, got ${uncompressed.length}`);
  }
  if (isAllZero(uncompressed)) return new Uint8Array(64);
  const x = uncompressed.slice(0, 64);
  const y0 = beToBigInt(uncompressed.slice(64, 96));
  const y1 = beToBigInt(uncompressed.slice(96, 128));
  assertCanonicalFq(beToBigInt(x.slice(0, 32)), "G2.x0");
  assertCanonicalFq(beToBigInt(x.slice(32, 64)), "G2.x1");
  assertCanonicalFq(y0, "G2.y0");
  assertCanonicalFq(y1, "G2.y1");
  const out = x.slice();
  if (fq2SignFlagBit(y0, y1)) out[0] = (out[0] ?? 0) | SIGN_FLAG_BIT;
  return out;
}

/** Total compressed proof wire size: `A(32) ‖ B(64) ‖ C(32) ‖ commitment(32) ‖ pok(32)`. */
export const COMPRESSED_PROOF_LEN = 192;

/**
 * Compresses a decoded Groth16 proof bundle (see `decodeProof`) into the 192-byte on-chain wire
 * format `kakure_pool`'s instructions now carry (workstream G): `A(32) ‖ B(64) ‖ C(32) ‖
 * commitment(32) ‖ commitment_pok(32)`. Assumes exactly one Pedersen commitment (`commitmentCount
 * === 1`), which is what every v1 circuit emits; `decodeProof` itself does not enforce this, so it
 * is checked here.
 */
export function compressDecodedProof(decoded: DecodedProof): Uint8Array {
  if (decoded.commitmentCount !== 1) {
    throw new ProofError(
      "encode",
      `compressDecodedProof expects exactly one commitment, got ${decoded.commitmentCount}`,
    );
  }
  const out = new Uint8Array(COMPRESSED_PROOF_LEN);
  out.set(compressG1(decoded.a), 0);
  out.set(compressG2(decoded.b), 32);
  out.set(compressG1(decoded.c), 96);
  out.set(compressG1(decoded.commitments), 128);
  out.set(compressG1(decoded.commitmentPok), 160);
  return out;
}

/**
 * Compresses a bundle's raw, uncompressed 388-byte `.proof` bytes (the format `decodeProof`
 * parses) into the 192-byte on-chain wire format. This is the function the chain-facing
 * transaction builders (`packages/sdk`) call -- the uncompressed form (`proofBytesForChain`,
 * `decode.ts`) remains available for `sunspot verify` parity tests, which still want the
 * uncompressed CPI layout.
 */
export function compressProof(bundle: { proof: Uint8Array; publicInputs: readonly Uint8Array[] }): Uint8Array {
  return compressDecodedProof(decodeProof(bundle.proof));
}
