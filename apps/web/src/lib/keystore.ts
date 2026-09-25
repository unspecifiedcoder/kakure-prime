/**
 * Browser encrypted store, ported from `packages/cli/src/keystore.ts`'s crypto choices (scrypt
 * N=2^15,r=8,p=1 -> XChaCha20-Poly1305 via `@noble/ciphers`/`@noble/hashes`) but reimplemented
 * without Node's `fs`/`Buffer` -- persistence here is IndexedDB, and bytes<->string uses a manual
 * base64 codec so nothing pulls Node polyfills into the browser bundle (see also
 * `packages/helper/src/wire.ts`, which has the same constraint for the same reason).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scrypt } from "@noble/hashes/scrypt";

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 24;

const DB_NAME = "kakure-web";
const DB_VERSION = 1;
const STORE_NAME = "encrypted-blobs";

export class KeystoreDecryptError extends Error {
  constructor() {
    super("Wrong passphrase, or this data is corrupted.");
    this.name = "KeystoreDecryptError";
  }
}

interface EncryptedBlob {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; salt: string };
  cipher: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 0x3f];
  }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B64_CHARS.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return scrypt(new TextEncoder().encode(passphrase), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: KEY_LEN,
  });
}

function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function encryptJson<T>(value: T, passphrase: string): EncryptedBlob {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const nonce = randomBytes(NONCE_LEN);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return {
    version: 1,
    kdf: "scrypt",
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: toBase64(salt) },
    cipher: "xchacha20poly1305",
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}

export function decryptJson<T>(blob: EncryptedBlob, passphrase: string): T {
  if (blob.version !== 1 || blob.kdf !== "scrypt" || blob.cipher !== "xchacha20poly1305") {
    throw new Error(`keystore: unsupported format (version=${blob.version})`);
  }
  const salt = fromBase64(blob.kdfParams.salt);
  const key = deriveKey(passphrase, salt);
  const nonce = fromBase64(blob.nonce);
  const ciphertext = fromBase64(blob.ciphertext);
  try {
    const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (err) {
    if (err instanceof KeystoreDecryptError) throw err;
    throw new KeystoreDecryptError();
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbKeys(): Promise<string[]> {
  const db = await openDb();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

/** Persists an arbitrary JSON-serializable value (e.g. a treasury's DKG output/group record)
 *  passphrase-encrypted in IndexedDB, keyed by `id`. Never call with a spend key alone unwrapped —
 *  callers should encrypt the whole record, which is what this function does. */
export async function saveEncrypted<T>(id: string, value: T, passphrase: string): Promise<void> {
  await idbPut(id, encryptJson(value, passphrase));
}

export async function loadEncrypted<T>(id: string, passphrase: string): Promise<T> {
  const blob = await idbGet<EncryptedBlob>(id);
  if (!blob) throw new Error(`keystore: no record for id "${id}"`);
  return decryptJson<T>(blob, passphrase);
}

export async function removeEncrypted(id: string): Promise<void> {
  await idbDelete(id);
}

export async function listEncryptedIds(): Promise<string[]> {
  return idbKeys();
}

/** For the "export/import encrypted config" settings feature: returns the raw encrypted blob (not
 *  the decrypted record) so it can be downloaded as a file without ever touching plaintext. */
export async function exportEncryptedBlob(id: string): Promise<string> {
  const blob = await idbGet<EncryptedBlob>(id);
  if (!blob) throw new Error(`keystore: no record for id "${id}"`);
  return JSON.stringify(blob);
}

export async function importEncryptedBlob(id: string, json: string): Promise<void> {
  const blob = JSON.parse(json) as EncryptedBlob;
  await idbPut(id, blob);
}
