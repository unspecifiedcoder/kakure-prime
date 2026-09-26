import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { PublicKey } from "@solana/web3.js";
import { SolanaAccount } from "@kakure/sdk";
import { ACCOUNT_SEED_MESSAGE } from "@kakure/sdk";

export interface ConnectedWallet {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction<T extends { serialize?: unknown }>(tx: T): Promise<T>;
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

/**
 * Spec §1.1: "The connected wallet's signature over `kakure.account.v1` seeds the `SolanaAccount`
 * (SDK) — no seed phrases shown." Requires the SDK's `fromAccountSignature` (added for this
 * workstream) since a wallet-standard adapter only ever hands back a signature, never a raw seed.
 */
export async function deriveAccount(wallet: ConnectedWallet): Promise<SolanaAccount> {
  const signature = await wallet.signMessage(ACCOUNT_SEED_MESSAGE);
  return SolanaAccount.fromAccountSignature(signature);
}
