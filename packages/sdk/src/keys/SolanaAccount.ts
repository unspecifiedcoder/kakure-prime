import { Fr } from "@aztec/foundation/fields";
import type { DerivedEph } from "../types/ephemeral.js";
import type { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { Point } from "@zk-kit/baby-jubjub";
import { Kdf } from "../crypto/Kdf.js";
import { toReducedFr } from "../crypto/fields.js";
import { IDarkAccount } from "../interfaces.js";
import {
  CanonicalAddress,
  PublicIncomingAddress,
  canonicalIncomingAddress,
  canonicalPublicAddress,
  canonicalSelfTag,
  deriveIncomingKey,
  derivePublicIncomingKey,
  deriveSelfEphemeral,
  deriveSelfSpendKey,
  deriveViewKey,
  publicKey,
} from "../note/keys.js";

// Ported from the reference EVM implementation's wallets package/src/keys/DarkAccount.ts. Master-plan item C.4: replace the EVM
// `DarkAccount` (root secret = deterministic ECDSA signature over a fixed message) with a Solana-keyed
// account (root secret = deterministic ed25519 signature over a fixed message), keeping the rest of the
// derived key hierarchy (note/keys.ts) byte-identical.
const ROOT_LABEL = "kakure.root";
const PSS_STATE_LABEL = "kakure.pss.state";

/** Domain-separated so a `SolanaAccount` signature can never collide with an unrelated wallet signature. */
export const ACCOUNT_SEED_MESSAGE = new TextEncoder().encode(
  "kakure.account.v1",
);

class DerivationError extends Error {
  constructor(msg: string) {
    super(`SolanaAccount Derivation: ${msg}`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class SolanaAccount implements IDarkAccount {
  // #private (not TS `private`): key material is unreachable via spread/Object.keys/structuredClone.
  #skRoot: Fr;
  #skView?: Fr;
  #selfSpend?: Fr;
  #stateKey?: Fr;

  private constructor(skRoot: Fr) {
    this.#skRoot = skRoot;
  }

  public toJSON(): never {
    throw new DerivationError("refusing to serialize key material");
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SolanaAccount <redacted>";
  }

  public async getViewKey(): Promise<Fr> {
    if (this.#skView === undefined) {
      this.#skView = await deriveViewKey(this.#skRoot);
    }
    return this.#skView;
  }

  public async getIncomingKey(index: bigint): Promise<Fr> {
    return deriveIncomingKey(await this.getViewKey(), index);
  }

  public async getIncomingPub(index: bigint): Promise<Point<bigint>> {
    return publicKey(await this.getIncomingKey(index));
  }

  public async getPublicIncomingKey(index: bigint): Promise<Fr> {
    return derivePublicIncomingKey(await this.getViewKey(), index);
  }

  public async getPublicIncomingPub(index: bigint): Promise<Point<bigint>> {
    return publicKey(await this.getPublicIncomingKey(index));
  }

  public async getSelfEphemeral(index: bigint): Promise<DerivedEph> {
    return deriveSelfEphemeral(await this.getViewKey(), index);
  }

  public async getSelfSpendKey(): Promise<Fr> {
    if (this.#selfSpend === undefined) {
      this.#selfSpend = await deriveSelfSpendKey(await this.getViewKey());
    }
    return this.#selfSpend;
  }

  public async getSelfSpendPub(): Promise<Point<bigint>> {
    return publicKey(await this.getSelfSpendKey());
  }

  /** Derived from the root secret, not the view key: state is not viewing material, so handing out the
   *  view key must not hand out the ability to read or forge state. */
  public async getStateKey(): Promise<Fr> {
    if (this.#stateKey === undefined) {
      this.#stateKey = await Kdf.derive(PSS_STATE_LABEL, this.#skRoot);
    }
    return this.#stateKey;
  }

  public async canonicalIncomingAddress(
    startIndex: bigint,
  ): Promise<CanonicalAddress> {
    return canonicalIncomingAddress(await this.getViewKey(), startIndex);
  }

  public async canonicalSelfTag(
    startIndex: bigint,
  ): Promise<CanonicalAddress> {
    return canonicalSelfTag(await this.getViewKey(), startIndex);
  }

  public async canonicalPublicAddress(
    index: bigint,
  ): Promise<PublicIncomingAddress> {
    return canonicalPublicAddress(await this.getViewKey(), index);
  }

  /**
   * The signature IS the root secret: MUST be deterministic and never exposed (disclosure recovers
   * sk_root). ed25519 signatures are deterministic by construction (RFC 8032), unlike ECDSA which needs an
   * explicit deterministic-nonce scheme -- so, unlike the reference EVM implementation's `fromSignature`, no nonce derivation is
   * needed here.
   */
  public static async fromKeypair(keypair: Keypair): Promise<SolanaAccount> {
    // `Keypair.secretKey` is the 64-byte tweetnacl-convention secret (32-byte seed || 32-byte pubkey);
    // noble's `ed25519.sign` wants only the 32-byte seed.
    const seed = keypair.secretKey.slice(0, 32);
    const signature = ed25519.sign(ACCOUNT_SEED_MESSAGE, seed);
    const skRoot = await Kdf.derive(
      ROOT_LABEL,
      toReducedFr("0x" + bytesToHex(signature)),
    );
    return new SolanaAccount(skRoot);
  }

  /**
   * Browser-wallet constructor: a wallet-standard adapter (Phantom et al.) exposes only
   * `signMessage(message): Promise<Uint8Array>` -- it signs on request but never hands the app a raw
   * seed, so `fromKeypair` (which needs the 32-byte ed25519 seed to *produce* the deterministic
   * signature itself) cannot be used from a web app. This constructor instead takes an
   * already-produced signature over `ACCOUNT_SEED_MESSAGE` (the caller is responsible for having the
   * wallet sign exactly that message) and runs it through the same KDF as `fromKeypair`. Determinism
   * still holds: a wallet-standard `signMessage` over a fixed message from a fixed keypair is the same
   * ed25519 signature every time (RFC 8032), so this yields the same `SolanaAccount` on every visit.
   */
  public static async fromAccountSignature(
    signature: Uint8Array,
  ): Promise<SolanaAccount> {
    const skRoot = await Kdf.derive(
      ROOT_LABEL,
      toReducedFr("0x" + bytesToHex(signature)),
    );
    return new SolanaAccount(skRoot);
  }

  /**
   * Test/tooling-only deterministic constructor: derives the root secret directly from an arbitrary seed
   * rather than from a live ed25519 signature. Mirrors the reference EVM implementation's `fromMnemonic` escape hatch (used only by
   * the ported unit tests below) without pulling in a BIP-39 implementation this package has no other use
   * for.
   */
  public static async fromSeed(seed: Uint8Array | string): Promise<SolanaAccount> {
    const bytes =
      typeof seed === "string" ? new TextEncoder().encode(seed) : seed;
    const skRoot = await Kdf.derive(
      ROOT_LABEL,
      toReducedFr("0x" + bytesToHex(bytes)),
    );
    return new SolanaAccount(skRoot);
  }

  /**
   * slice-2 F-7: browser-wallet-adapter constructor (`fromKeypair` above signs
   * `ACCOUNT_SEED_MESSAGE` locally with noble against a raw `Keypair` and is unaffected -- it is
   * never shown to a user as a "sign this" prompt). This one derives the SAME KIND of root secret
   * from a signature the wallet UI actually prompted the user for, so the message signed there
   * must not be an opaque 17-byte string: `formatWalletAccountSeedMessage` wraps it in Solana's
   * off-chain-message envelope with a human-readable warning and the wallet's own address (so a
   * substituted address changes the derived key, and phishing this signature is at least
   * recognizable as "this is my Kakure key", not "sign in").
   *
   * `signMessage` is called TWICE and the two signatures compared (`DerivationError` on mismatch):
   * the signature IS the root secret, so a signer that is not perfectly deterministic (unlike a
   * bare ed25519 `Keypair`, some hardware/browser wallet signing paths are not) must never be
   * trusted to derive one -- silently deriving a different key each session would look like key
   * loss, not a caught bug.
   */
  public static async fromWalletSigner(
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
    walletBase58: string,
    appOrigin?: string,
  ): Promise<SolanaAccount> {
    const message = formatWalletAccountSeedMessage(walletBase58, appOrigin);
    const [sig1, sig2] = await Promise.all([signMessage(message), signMessage(message)]);
    if (bytesToHex(sig1) !== bytesToHex(sig2)) {
      throw new DerivationError(
        "signer is not deterministic (two signatures over the same message differed) -- " +
          "refusing to derive a root secret from it",
      );
    }
    const skRoot = await Kdf.derive(ROOT_LABEL, toReducedFr("0x" + bytesToHex(sig1)));
    return new SolanaAccount(skRoot);
  }
}

/**
 * Solana's "off-chain message" signing envelope (the format Ledger's Solana app -- and several
 * software wallets -- require rather than a raw byte string): `0xff ‖ "solana offchain" ‖
 * version:u8 ‖ format:u8 ‖ length:u16 LE ‖ message`. `format = 2` (extended UTF-8) is used since
 * the human-readable warning below is ASCII but we don't want to re-derive this if it later gains
 * non-ASCII text.
 */
const OFFCHAIN_MESSAGE_HEADER = new Uint8Array([
  0xff,
  ...new TextEncoder().encode("solana offchain"),
]);
const OFFCHAIN_MESSAGE_VERSION = 0;
const OFFCHAIN_MESSAGE_FORMAT_EXTENDED_UTF8 = 2;

export function encodeSolanaOffchainMessage(message: Uint8Array): Uint8Array {
  if (message.length > 0xffff) {
    throw new DerivationError(`off-chain message too long: ${message.length} bytes`);
  }
  const lenBytes = new Uint8Array(2);
  new DataView(lenBytes.buffer).setUint16(0, message.length, true);
  const out = new Uint8Array(
    OFFCHAIN_MESSAGE_HEADER.length + 1 + 1 + lenBytes.length + message.length,
  );
  let off = 0;
  out.set(OFFCHAIN_MESSAGE_HEADER, off);
  off += OFFCHAIN_MESSAGE_HEADER.length;
  out[off++] = OFFCHAIN_MESSAGE_VERSION;
  out[off++] = OFFCHAIN_MESSAGE_FORMAT_EXTENDED_UTF8;
  out.set(lenBytes, off);
  off += lenBytes.length;
  out.set(message, off);
  return out;
}

/**
 * The human-readable text a wallet-adapter `signMessage` prompt shows for `fromWalletSigner`:
 * names what the signature is for, warns it must only be signed on the real app, and binds the
 * wallet's own address into the signed bytes (so an attacker who gets a user to sign this for a
 * DIFFERENT wallet address gets a different, useless key).
 */
export function formatWalletAccountSeedMessage(
  walletBase58: string,
  appOrigin = "app.kakure",
): Uint8Array {
  const text =
    `kakure.account.v1\n` +
    `This signature is your Kakure spending key. Only sign on ${appOrigin}.\n` +
    `Wallet: ${walletBase58}`;
  return encodeSolanaOffchainMessage(new TextEncoder().encode(text));
}
