import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519 } from "@noble/curves/ed25519";
import { scryptAsync } from "@noble/hashes/scrypt";
import { randomBytes } from "@noble/hashes/utils";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";

type Vault = { version: 1; address: string; salt: number[]; nonce: number[]; ciphertext: number[] };
type Pending = { origin: string; method: string; params: unknown; resolve: (value: unknown) => void; reject: (reason: Error) => void };

const encoder = new TextEncoder();
let unlocked: Keypair | null = null;
const pending = new Map<string, Pending>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(encoder.encode(passphrase), salt, { N: 2 ** 17, r: 8, p: 1, dkLen: 32 });
}

async function readVault(): Promise<Vault | null> {
  const result = await chrome.storage.local.get("vault");
  return (result.vault as Vault | undefined) ?? null;
}

async function createVault(passphrase: string): Promise<string> {
  if (passphrase.length < 12) throw new Error("Use at least 12 characters.");
  if (await readVault()) throw new Error("A Kakure Wallet already exists in this profile.");
  const keypair = Keypair.generate();
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(keypair.secretKey);
  const vault: Vault = { version: 1, address: keypair.publicKey.toBase58(), salt: [...salt], nonce: [...nonce], ciphertext: [...ciphertext] };
  await chrome.storage.local.set({ vault, network: "devnet" });
  unlocked = keypair;
  chrome.alarms.create("kakure-auto-lock", { delayInMinutes: 15 });
  return vault.address;
}

async function unlockVault(passphrase: string): Promise<string> {
  const vault = await readVault();
  if (!vault) throw new Error("Create a Kakure Wallet first.");
  try {
    const key = await deriveKey(passphrase, Uint8Array.from(vault.salt));
    const secret = xchacha20poly1305(key, Uint8Array.from(vault.nonce)).decrypt(Uint8Array.from(vault.ciphertext));
    const keypair = Keypair.fromSecretKey(secret);
    if (keypair.publicKey.toBase58() !== vault.address) throw new Error("Wallet integrity check failed.");
    unlocked = keypair;
    chrome.alarms.create("kakure-auto-lock", { delayInMinutes: 15 });
    return vault.address;
  } catch {
    throw new Error("Incorrect passphrase or damaged encrypted vault.");
  }
}

async function status() {
  const vault = await readVault();
  const stored = await chrome.storage.local.get("network");
  return { exists: Boolean(vault), unlocked: Boolean(unlocked), address: vault?.address ?? null, network: stored.network ?? "devnet" };
}

async function activeConnection(): Promise<{ connection: Connection; network: "devnet" | "mainnet-beta" }> {
  const stored = await chrome.storage.local.get("network");
  const network = stored.network === "mainnet-beta" ? "mainnet-beta" : "devnet";
  return { connection: new Connection(network === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com", "confirmed"), network };
}

async function balance(): Promise<number> {
  if (!unlocked) throw new Error("Unlock Kakure Wallet first.");
  const { connection } = await activeConnection();
  return (await connection.getBalance(unlocked.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
}

async function sendSol(recipient: string, amount: number): Promise<{ signature: string; explorer: string }> {
  if (!unlocked) throw new Error("Unlock Kakure Wallet first.");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a positive SOL amount.");
  const destination = new PublicKey(recipient);
  const { connection, network } = await activeConnection();
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: unlocked.publicKey, recentBlockhash: latest.blockhash }).add(
    SystemProgram.transfer({ fromPubkey: unlocked.publicKey, toPubkey: destination, lamports: Math.round(amount * LAMPORTS_PER_SOL) }),
  );
  transaction.sign(unlocked);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 8,
  });
  return { signature, explorer: `https://explorer.solana.com/tx/${signature}${network === "devnet" ? "?cluster=devnet" : ""}` };
}

async function performSigning(method: string, params: any): Promise<unknown> {
  if (!unlocked) throw new Error("Kakure Wallet is locked. Open the extension to unlock it.");
  if (method === "signMessage") {
    const signature = ed25519.sign(base64ToBytes(params.message), unlocked.secretKey.slice(0, 32));
    return { signature: bytesToBase64(signature), publicKey: unlocked.publicKey.toBase58() };
  }
  if (method === "signTransaction") {
    const bytes = base64ToBytes(params.transaction);
    if (params.versioned) {
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign([unlocked]);
      return { transaction: bytesToBase64(transaction.serialize()) };
    }
    const transaction = Transaction.from(bytes);
    transaction.partialSign(unlocked);
    return { transaction: bytesToBase64(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })) };
  }
  throw new Error(`Unsupported signing request: ${method}`);
}

async function requestApproval(origin: string, method: string, params: unknown): Promise<unknown> {
  if (!unlocked) throw new Error("Kakure Wallet is locked. Open the extension to unlock it.");
  const id = crypto.randomUUID();
  const result = new Promise((resolve, reject) => pending.set(id, { origin, method, params, resolve, reject }));
  await chrome.windows.create({ url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`), type: "popup", width: 410, height: 650 });
  return result;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "kakure-auto-lock") unlocked = null;
});

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  void (async () => {
    if (message.type === "status") return status();
    if (message.type === "create") return { address: await createVault(message.passphrase) };
    if (message.type === "unlock") return { address: await unlockVault(message.passphrase) };
    if (message.type === "lock") { unlocked = null; return { ok: true }; }
    if (message.type === "network") { await chrome.storage.local.set({ network: message.network }); return { ok: true }; }
    if (message.type === "balance") return { balance: await balance() };
    if (message.type === "sendSol") return sendSol(message.recipient, Number(message.amount));
    if (message.type === "pending:get") {
      const request = pending.get(message.id);
      return request ? { origin: request.origin, method: request.method, detail: request.method === "signMessage" ? "Derive your private Kakure account" : "Sign a Solana transaction" } : null;
    }
    if (message.type === "pending:reject") { pending.get(message.id)?.reject(new Error("Request rejected by the user.")); pending.delete(message.id); return { ok: true }; }
    if (message.type === "pending:approve") {
      const request = pending.get(message.id);
      if (!request) throw new Error("Signing request expired.");
      const result = await performSigning(request.method, request.params);
      request.resolve(result);
      pending.delete(message.id);
      return { ok: true };
    }
    if (message.type === "kakure-page-request") {
      const origin = sender.tab?.url ? new URL(sender.tab.url).origin : "Unknown site";
      if (message.method === "connect") {
        const current = await status();
        if (!current.unlocked || !current.address) throw new Error("Kakure Wallet is locked. Open the extension to unlock it.");
        return { publicKey: current.address };
      }
      return requestApproval(origin, message.method, message.params);
    }
    throw new Error("Unknown Kakure Wallet request.");
  })().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
