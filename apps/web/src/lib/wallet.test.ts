import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_SEED_MESSAGE, SolanaAccount } from "@kakure/sdk";
import { deriveAccount, type ConnectedWallet } from "./wallet.js";

function fakeWallet(seed: Uint8Array): ConnectedWallet {
  const pub = ed25519.getPublicKey(seed);
  return {
    publicKey: new PublicKey(pub),
    async signMessage(message: Uint8Array) {
      // Only ever asked to sign ACCOUNT_SEED_MESSAGE in this flow; a real Phantom wallet does the
      // equivalent deterministic ed25519 signature under the hood.
      return ed25519.sign(message, seed);
    },
    async signTransaction(tx) {
      return tx;
    },
  };
}

describe("lib/wallet deriveAccount (spec §1.1: wallet signature seeds SolanaAccount, no seed phrase)", () => {
  it("only ever asks the wallet to sign ACCOUNT_SEED_MESSAGE", async () => {
    const seed = new Uint8Array(32).fill(3);
    let signedMessage: Uint8Array | undefined;
    const wallet: ConnectedWallet = {
      publicKey: new PublicKey(ed25519.getPublicKey(seed)),
      async signMessage(message) {
        signedMessage = message;
        return ed25519.sign(message, seed);
      },
      async signTransaction(tx) {
        return tx;
      },
    };
    await deriveAccount(wallet);
    expect(signedMessage).toEqual(ACCOUNT_SEED_MESSAGE);
  });

  it("derives the same SolanaAccount as fromKeypair for the same underlying seed", async () => {
    const seed = new Uint8Array(32).fill(7);
    const wallet = fakeWallet(seed);
    const viaWallet = await deriveAccount(wallet);

    const signature = ed25519.sign(ACCOUNT_SEED_MESSAGE, seed);
    const direct = await SolanaAccount.fromAccountSignature(signature);

    expect((await viaWallet.getViewKey()).toString()).toBe((await direct.getViewKey()).toString());
  });

  it("derives different accounts for different wallets", async () => {
    const a = await deriveAccount(fakeWallet(new Uint8Array(32).fill(1)));
    const b = await deriveAccount(fakeWallet(new Uint8Array(32).fill(2)));
    expect((await a.getViewKey()).toString()).not.toBe((await b.getViewKey()).toString());
  });
});
