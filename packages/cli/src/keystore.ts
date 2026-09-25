/**
 * Encrypted keystore: `Keypair.secretKey` (64 bytes) at rest, protected by a passphrase via
 * scrypt (N=2^17, r=8, p=1, dkLen=32) -> XChaCha20-Poly1305, per the master plan's "keys
 * encrypted at rest with scrypt + xchacha20-poly1305" requirement (`@noble/ciphers`).
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { Keypair } from "@solana/web3.js";

// slice-2 F-11: raised from 2^15 (~60ms) to 2^17 (~240ms) -- 2^15 is below the usual 2^17 for an
// interactive spend-key store. This is only the default for NEW encryptions: every keystore file
// carries its own `kdfParams.{N,r,p}` and `decryptBytes` derives with the STORED params, not these
// module constants, so an existing keystore written under the old N keeps opening.
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 24;

export class KeystoreDecryptError extends Error {
  constructor() {
    super("keystore: decryption failed (wrong passphrase or corrupted file)");
    this.name = "KeystoreDecryptError";
  }
}

interface KeystoreFile {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; salt: string };
  cipher: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Uint8Array, params: { N: number; r: number; p: number }): Uint8Array {
  return scrypt(new TextEncoder().encode(passphrase), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: KEY_LEN,
  });
}

/** Encrypts arbitrary bytes for `passphrase`; the generic primitive `encryptKeypair`/`encryptJson` share. */
export function encryptBytes(plaintext: Uint8Array, passphrase: string): KeystoreFile {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return {
    version: 1,
    kdf: "scrypt",
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: Buffer.from(salt).toString("base64") },
    cipher: "xchacha20poly1305",
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

/** Decrypts a keystore file produced by `encryptBytes`. Throws `KeystoreDecryptError` on any AEAD failure. */
export function decryptBytes(file: KeystoreFile, passphrase: string): Uint8Array {
  if (file.version !== 1 || file.kdf !== "scrypt" || file.cipher !== "xchacha20poly1305") {
    throw new Error(`keystore: unsupported keystore format (version=${file.version})`);
  }
  const salt = Buffer.from(file.kdfParams.salt, "base64");
  // slice-2 F-11: derive with the STORED params (not the module's current defaults) so a
  // keystore written under an older/different N/r/p keeps opening after this file bumps them.
  const key = deriveKey(passphrase, salt, {
    N: file.kdfParams.N,
    r: file.kdfParams.r,
    p: file.kdfParams.p,
  });
  const nonce = Buffer.from(file.nonce, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");
  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new KeystoreDecryptError();
  }
}

/** Encrypts `keypair.secretKey` for `passphrase` and returns the JSON-serializable keystore. */
export function encryptKeypair(keypair: Keypair, passphrase: string): KeystoreFile {
  return encryptBytes(keypair.secretKey, passphrase);
}

/** Decrypts a keystore produced by `encryptKeypair`. Throws `KeystoreDecryptError` on any AEAD failure. */
export function decryptKeypair(file: KeystoreFile, passphrase: string): Keypair {
  return Keypair.fromSecretKey(decryptBytes(file, passphrase));
}

/** Encrypts an arbitrary JSON-serializable record (e.g. a group's DKG output) for `passphrase`. */
export function encryptJson<T>(value: T, passphrase: string): KeystoreFile {
  return encryptBytes(new TextEncoder().encode(JSON.stringify(value)), passphrase);
}

/** Decrypts a record produced by `encryptJson`. */
export function decryptJson<T>(file: KeystoreFile, passphrase: string): T {
  return JSON.parse(new TextDecoder().decode(decryptBytes(file, passphrase))) as T;
}

export async function writeKeystoreFile(path: string, keypair: Keypair, passphrase: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = encryptKeypair(keypair, passphrase);
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeEncryptedJsonFile<T>(path: string, value: T, passphrase: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = encryptJson(value, passphrase);
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readEncryptedJsonFile<T>(path: string, passphrase: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  const file = JSON.parse(raw) as KeystoreFile;
  return decryptJson<T>(file, passphrase);
}

export async function readKeystoreFile(path: string, passphrase: string): Promise<Keypair> {
  const raw = await readFile(path, "utf-8");
  const file = JSON.parse(raw) as KeystoreFile;
  return decryptKeypair(file, passphrase);
}
