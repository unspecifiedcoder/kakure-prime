/**
 * Point-to-point sealing for coordinator envelopes (I-7). Each member's Solana ed25519 identity
 * key is converted to an X25519 key pair (`edwardsToMontgomeryPriv/Pub`, RFC 7748 birational map);
 * a DKG round's payload to a given recipient is ECDH(sender X25519 priv, recipient X25519 pub) ->
 * XChaCha20-Poly1305 seal. This is DIFFERENT from `@kakure/sdk`'s `combineGroupViewContributions`/
 * `deriveGroupViewKeyFromSecret`: those derive the GROUP's shared canonical viewing key from the
 * DKG's round-2 `r_i` contributions (sealed pairwise using exactly this module) once every member
 * has one; there is no group key yet during the ceremony itself, so round messages are sealed
 * pairwise instead. See the CLI README for this split.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { edwardsToMontgomeryPriv, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface X25519KeyPair {
  readonly priv: Uint8Array;
  readonly pub: Uint8Array;
}

/** Derives this member's X25519 key pair from their ed25519 identity seed. */
export function x25519FromEd25519Seed(ed25519Seed: Uint8Array): X25519KeyPair {
  const priv = edwardsToMontgomeryPriv(ed25519Seed);
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

const NONCE_LEN = 24; // XChaCha20's extended nonce.
const BOX_KEY_INFO_PREFIX = "kakure.dkg.box.v1";

/**
 * slice-2 F-11: the raw X25519 ECDH output was used DIRECTLY as the AEAD key -- functionally fine
 * (a proper ECDH shared secret, not attacker-influenceable), but not standard practice: it skips a
 * KDF, has no transcript binding (the same shared secret would produce the same key for every
 * session between the same two parties, if one were ever reused across sessions), and mixes
 * "the DH output" with "the symmetric key" instead of keeping them as separate steps one of which
 * can be swapped independently. `HKDF-SHA256(shared, info = "kakure.dkg.box.v1" ‖ senderPub ‖
 * recipientPub ‖ sessionId)` binds the key to both parties' identities and the specific session.
 */
function deriveBoxKey(shared: Uint8Array, senderPub: Uint8Array, recipientPub: Uint8Array, sessionId: string): Uint8Array {
  const info = new Uint8Array([
    ...new TextEncoder().encode(`${BOX_KEY_INFO_PREFIX}|`),
    ...senderPub,
    ...recipientPub,
    ...new TextEncoder().encode(`|${sessionId}`),
  ]);
  return hkdf(sha256, shared, undefined, info, 32);
}

/** Seals `plaintext` for `recipientX25519Pub` using `deriveBoxKey(ECDH(myPriv, theirPub), ...)` as
 *  the symmetric key, bound to this specific `sessionId`. */
export function sealTo(
  myPriv: Uint8Array,
  recipientX25519Pub: Uint8Array,
  sessionId: string,
  plaintext: Uint8Array,
): Uint8Array {
  const myPub = x25519.getPublicKey(myPriv);
  const shared = x25519.getSharedSecret(myPriv, recipientX25519Pub);
  const key = deriveBoxKey(shared, myPub, recipientX25519Pub, sessionId);
  const nonce = randomBytes(NONCE_LEN);
  const sealed = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_LEN + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_LEN);
  return out;
}

/** Opens a box produced by `sealTo` where `senderX25519Pub` is the sender's X25519 public key. */
export function openFrom(
  myPriv: Uint8Array,
  senderX25519Pub: Uint8Array,
  sessionId: string,
  sealed: Uint8Array,
): Uint8Array {
  const myPub = x25519.getPublicKey(myPriv);
  const shared = x25519.getSharedSecret(myPriv, senderX25519Pub);
  const key = deriveBoxKey(shared, senderX25519Pub, myPub, sessionId);
  const nonce = sealed.slice(0, NONCE_LEN);
  const ciphertext = sealed.slice(NONCE_LEN);
  return xchacha20poly1305(key, nonce).decrypt(ciphertext);
}
