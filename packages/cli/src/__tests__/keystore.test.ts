import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  KeystoreDecryptError,
  decryptKeypair,
  encryptKeypair,
  readEncryptedJsonFile,
  readKeystoreFile,
  writeEncryptedJsonFile,
  writeKeystoreFile,
} from "../keystore.js";

describe("keystore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kakure-keystore-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a keypair through encrypt/decrypt", () => {
    const kp = Keypair.generate();
    const file = encryptKeypair(kp, "correct horse battery staple");
    const recovered = decryptKeypair(file, "correct horse battery staple");
    expect(recovered.secretKey).toEqual(kp.secretKey);
    expect(recovered.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("rejects the wrong passphrase", () => {
    const kp = Keypair.generate();
    const file = encryptKeypair(kp, "right passphrase");
    expect(() => decryptKeypair(file, "wrong passphrase")).toThrow(KeystoreDecryptError);
  });

  it("writes the keystore file mode 0600 and round-trips via disk", async () => {
    const kp = Keypair.generate();
    const path = join(dir, "keystore.json");
    await writeKeystoreFile(path, kp, "hunter2");
    const st = await stat(path);
    // Windows does not expose POSIX permission bits through stat/chmod.
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    const recovered = await readKeystoreFile(path, "hunter2");
    expect(recovered.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("round-trips an arbitrary JSON record (e.g. a group's DKG output)", async () => {
    const record = { gpk: { x: "0x1", y: "0x2" }, myId: "1", mySecretShare: "123456789" };
    const path = join(dir, "group.json");
    await writeEncryptedJsonFile(path, record, "group-pass");
    const recovered = await readEncryptedJsonFile<typeof record>(path, "group-pass");
    expect(recovered).toEqual(record);
  });

  // slice-2 F-11: the current default is raised to 2^17; a keystore whose FILE says a different
  // (e.g. older, lower) N must still decrypt with that stored N, not the module's current default.
  it("decrypts a keystore whose stored kdfParams.N differs from the current default", () => {
    const kp = Keypair.generate();
    const passphrase = "correct horse battery staple";
    const file = encryptKeypair(kp, passphrase);
    expect(file.kdfParams.N).toBe(1 << 17); // current default, sanity check

    // Simulate a pre-upgrade keystore file: same salt/nonce, but encrypted under the OLD N.
    const oldN = 1 << 15;
    const salt = Buffer.from(file.kdfParams.salt, "base64");
    const nonce = Buffer.from(file.nonce, "base64");
    const oldKey = scrypt(new TextEncoder().encode(passphrase), salt, { N: oldN, r: 8, p: 1, dkLen: 32 });
    const oldCiphertext = xchacha20poly1305(oldKey, nonce).encrypt(kp.secretKey);
    const oldStyleFile = {
      ...file,
      kdfParams: { ...file.kdfParams, N: oldN },
      ciphertext: Buffer.from(oldCiphertext).toString("base64"),
    };

    const recovered = decryptKeypair(oldStyleFile, passphrase);
    expect(recovered.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
});
