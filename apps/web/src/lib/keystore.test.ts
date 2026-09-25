import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveEncrypted,
  loadEncrypted,
  removeEncrypted,
  listEncryptedIds,
  exportEncryptedBlob,
  importEncryptedBlob,
  KeystoreDecryptError,
} from "./keystore.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const idb = (globalThis as any).indexedDB;

beforeEach(async () => {
  // fresh database per test
  await new Promise<void>((resolve, reject) => {
    const req = idb.deleteDatabase("kakure-web");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe("browser encrypted keystore (scrypt + xchacha20poly1305 in IndexedDB)", () => {
  it("round-trips a JSON-serializable record through the correct passphrase", async () => {
    const record = { name: "Acme treasury", threshold: 3, signers: ["a", "b", "c", "d", "e"] };
    await saveEncrypted("treasury-1", record, "correct horse battery staple");
    const loaded = await loadEncrypted("treasury-1", "correct horse battery staple");
    expect(loaded).toEqual(record);
  });

  it("throws KeystoreDecryptError on the wrong passphrase", async () => {
    await saveEncrypted("treasury-1", { x: 1 }, "right-passphrase");
    await expect(loadEncrypted("treasury-1", "wrong-passphrase")).rejects.toBeInstanceOf(KeystoreDecryptError);
  });

  it("lists and removes stored ids", async () => {
    await saveEncrypted("a", { v: 1 }, "pw");
    await saveEncrypted("b", { v: 2 }, "pw");
    expect((await listEncryptedIds()).sort()).toEqual(["a", "b"]);
    await removeEncrypted("a");
    expect(await listEncryptedIds()).toEqual(["b"]);
  });

  it("export/import round-trips the raw encrypted blob without ever decrypting it", async () => {
    await saveEncrypted("treasury-1", { secret: "shh" }, "pw123");
    const exported = await exportEncryptedBlob("treasury-1");
    expect(exported).not.toContain("shh"); // still ciphertext
    await removeEncrypted("treasury-1");
    await importEncryptedBlob("treasury-1", exported);
    const loaded = await loadEncrypted<{ secret: string }>("treasury-1", "pw123");
    expect(loaded.secret).toBe("shh");
  });

  it("rejects loading a missing id", async () => {
    await expect(loadEncrypted("nonexistent", "pw")).rejects.toThrow(/no record/);
  });
});
