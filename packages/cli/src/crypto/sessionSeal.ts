/**
 * Post-DKG coordinator envelope sealing (slice-2 F-2). Once a group exists, every `proposal`/
 * `nonce`/`share`/`final` envelope on its session carries the spend intent, FROST commitments, and
 * signature shares -- previously plaintext (base64 JSON) in the envelope's `ciphertext` field, so
 * the coordinator operator learned every spend's asset/amount/recipient, timing, and which signers
 * participated (spec §5's "coordinator sees ciphertext only" and "never learns ... amounts,
 * recipients or membership" were both false). Everyone in the group already shares the group view
 * secret `gvs` (`GroupRecord.groupViewKey.gvs`, combined once at DKG time), so this derives a
 * per-session symmetric key from it via HKDF-SHA256 and seals every post-DKG envelope with
 * XChaCha20-Poly1305 under that key -- the coordinator now sees only opaque, unparseable bytes.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const SESSION_KEY_INFO_PREFIX = "kakure.coordinator.session.v1";
const NONCE_LEN = 24;
const KEY_LEN = 32;

/** `K_session = HKDF-SHA256(gvs, info = "kakure.coordinator.session.v1" ‖ sessionId)`. */
export function deriveSessionKey(gvs: Uint8Array, sessionId: string): Uint8Array {
  const info = new TextEncoder().encode(`${SESSION_KEY_INFO_PREFIX}|${sessionId}`);
  return hkdf(sha256, gvs, undefined, info, KEY_LEN);
}

/** `GroupRecord.groupViewKey.gvs` is a DECIMAL bigint string (`Fr#toString()`); this is the
 *  32-byte big-endian encoding `deriveSessionKey` (and any other byte-oriented KDF input) needs. */
export function gvsDecimalToBytes(gvsDecimal: string): Uint8Array {
  const hexStr = BigInt(gvsDecimal).toString(16).padStart(64, "0");
  return new Uint8Array(Buffer.from(hexStr, "hex"));
}

/** Convenience: `deriveSessionKey(gvsDecimalToBytes(gvsDecimal), sessionId)`. */
export function deriveSessionKeyFromGvsDecimal(gvsDecimal: string, sessionId: string): Uint8Array {
  return deriveSessionKey(gvsDecimalToBytes(gvsDecimal), sessionId);
}

/** Seals `plaintext` under the session key; output is opaque bytes (nonce ‖ ciphertext), never
 *  parseable JSON and never containing the plaintext verbatim. */
export function sealSession(sessionKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const sealed = xchacha20poly1305(sessionKey, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_LEN + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_LEN);
  return out;
}

/** Inverse of `sealSession`. Throws if `sealed` was not produced under this `sessionKey`. */
export function openSession(sessionKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  const nonce = sealed.slice(0, NONCE_LEN);
  const ciphertext = sealed.slice(NONCE_LEN);
  return xchacha20poly1305(sessionKey, nonce).decrypt(ciphertext);
}

/** `sealSession` + base64, for direct use as an `Envelope.ciphertext`. */
export function sealSessionJson(sessionKey: Uint8Array, value: unknown): string {
  const bytes = sealSession(sessionKey, new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.from(bytes).toString("base64");
}

/** base64 + `openSession` + JSON.parse, for reading an `Envelope.ciphertext` sealed by
 *  `sealSessionJson`. */
export function openSessionJson<T>(sessionKey: Uint8Array, ciphertextB64: string): T {
  const sealed = new Uint8Array(Buffer.from(ciphertextB64, "base64"));
  const plaintext = openSession(sessionKey, sealed);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
