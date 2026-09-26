import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { SolanaAccount } from "@kakure/sdk";
import { ACCOUNT_SEED_MESSAGE } from "@kakure/sdk";
import { listEncryptedIds, loadEncrypted, saveEncrypted } from "./keystore.js";

export const KAKURE_WALLET_ID = "wallet:kakure:v1";

interface KakureWalletRecord {
  version: 1;
  publicKey: string;
  secretKey: number[];
  createdAt: string;
}

export interface ConnectedWallet {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction<T extends { serialize?: unknown }>(tx: T): Promise<T>;
}

interface KakureExtensionProvider {
  isKakure: boolean;
  publicKey: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  signTransaction<T>(transaction: T): Promise<T>;
}

let activeWallet: ConnectedWallet | null = null;

export function getActiveWallet(): ConnectedWallet | null {
  return activeWallet;
}

export function clearActiveWallet(): void {
  activeWallet = null;
}

function walletFromKeypair(keypair: Keypair): ConnectedWallet {
  return {
    publicKey: keypair.publicKey,
    signMessage: async (message) => ed25519.sign(message, keypair.secretKey.slice(0, 32)),
    signTransaction: async <T extends { serialize?: unknown }>(tx: T): Promise<T> => {
      const signable = tx as T & {
        partialSign?: (...signers: Keypair[]) => void;
        sign?: (signers: Keypair[]) => void;
      };
      if (typeof signable.partialSign === "function") signable.partialSign(keypair);
      else if (typeof signable.sign === "function") signable.sign([keypair]);
      else throw new Error("Kakure Wallet received an unsupported Solana transaction type");
      return tx;
    },
  };
}

export async function hasKakureWallet(): Promise<boolean> {
  return (await listEncryptedIds()).includes(KAKURE_WALLET_ID);
}

export async function createKakureWallet(passphrase: string): Promise<ConnectedWallet> {
  if (passphrase.length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  if (await hasKakureWallet()) throw new Error("Kakure Wallet already exists in this browser.");
  const keypair = Keypair.generate();
  const record: KakureWalletRecord = {
    version: 1,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
    createdAt: new Date().toISOString(),
  };
  await saveEncrypted(KAKURE_WALLET_ID, record, passphrase);
  activeWallet = walletFromKeypair(keypair);
  return activeWallet;
}

export async function unlockKakureWallet(passphrase: string): Promise<ConnectedWallet> {
  const record = await loadEncrypted<KakureWalletRecord>(KAKURE_WALLET_ID, passphrase);
  if (record.version !== 1 || record.secretKey.length !== 64) throw new Error("Unsupported Kakure Wallet record.");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(record.secretKey));
  if (keypair.publicKey.toBase58() !== record.publicKey) throw new Error("Kakure Wallet integrity check failed.");
  activeWallet = walletFromKeypair(keypair);
  return activeWallet;
}

/**
 * Thin wrapper over the wallet-standard Phantom adapter (spec §1.1/§2: "Connect Phantom
 * (wallet-standard)"). `connect()` never asks the wallet for anything but its public key and, on
 * demand, a message signature -- it never sees or asks for a seed phrase.
 */
export async function connectPhantom(): Promise<ConnectedWallet> {
  const injected = (globalThis as { phantom?: { solana?: { isPhantom?: boolean } } }).phantom?.solana;
  if (!injected?.isPhantom) {
    throw new Error("Phantom was not detected. Open this site in Chrome or Brave with the Phantom extension enabled.");
  }
  const adapter = new PhantomWalletAdapter();
  await adapter.connect();
  if (!adapter.publicKey) {
    throw new Error("Phantom did not return a public key after connect()");
  }
  return {
    publicKey: adapter.publicKey,
    signMessage: (message) => adapter.signMessage(message),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: (tx) => adapter.signTransaction(tx as any) as any,
  };
}

export async function connectKakureExtension(): Promise<ConnectedWallet> {
  const provider = (globalThis as typeof globalThis & { kakure?: KakureExtensionProvider }).kakure;
  if (!provider?.isKakure) {
    throw new Error("Kakure Wallet extension was not detected.");
  }
  const response = await provider.connect();
  const publicKey = new PublicKey(response.publicKey.toBase58());
  return {
    publicKey,
    signMessage: async (message) => (await provider.signMessage(message)).signature,
    signTransaction: (transaction) => provider.signTransaction(transaction),
  };
}

/** Prefers the Kakure extension, with Phantom as the wallet-standard fallback. */
export async function connectPreferredWallet(): Promise<ConnectedWallet> {
  if (activeWallet) return activeWallet;
  const kakure = (globalThis as typeof globalThis & { kakure?: KakureExtensionProvider }).kakure;
  if (kakure?.isKakure) return connectKakureExtension();
  const phantom = (globalThis as typeof globalThis & { phantom?: { solana?: { isPhantom?: boolean } } }).phantom?.solana;
  if (phantom?.isPhantom) return connectPhantom();
  throw new Error("No wallet extension detected. Install Kakure Wallet or enable Phantom, then reload this page.");
}

/**
 * Spec §1.1: "The connected wallet's signature over `kakure.account.v1` seeds the `SolanaAccount`
 * (SDK) — no seed phrases shown." Requires the SDK's `fromAccountSignature` (added for this
 * workstream) since a wallet-standard adapter only ever hands back a signature, never a raw seed.
 */
export async function deriveAccount(wallet: ConnectedWallet): Promise<SolanaAccount> {
  const signature = await wallet.signMessage(ACCOUNT_SEED_MESSAGE);
  return SolanaAccount.fromAccountSignature(signature);
}
