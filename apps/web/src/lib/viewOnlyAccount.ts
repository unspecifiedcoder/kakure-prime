import {
  Fr,
  IDarkAccount,
  DerivedEph,
  CanonicalAddress,
  PublicIncomingAddress,
  canonicalIncomingAddress,
  canonicalPublicAddress,
  canonicalSelfTag,
  deriveIncomingKey,
  derivePublicIncomingKey,
  deriveSelfEphemeral,
  deriveSelfSpendKey,
  publicKey,
} from "@kakure/sdk";
import type { Point } from "@zk-kit/baby-jubjub";

/**
 * Read-only `IDarkAccount` built directly from a view key. The dashboard never asks for or
 * stores a spend/root secret: every value `IDarkAccount` exposes (including `getSelfSpendKey`)
 * is derivable from the view key alone (see `packages/sdk/src/note/keys.ts`), so a scanner needs
 * nothing more to recognise both incoming and self-sent (change) notes and compute balances.
 *
 * `getStateKey()` is PSS/backup-service material derived from the root secret, not the view key
 * (see `SolanaAccount.getStateKey`) -- out of scope for a read-only dashboard, so it throws rather
 * than silently returning a wrong value.
 */
export class ViewOnlyAccount implements IDarkAccount {
  #selfSpend?: Fr;

  private constructor(private readonly viewKey: Fr) {}

  static fromViewKey(viewKey: Fr): ViewOnlyAccount {
    return new ViewOnlyAccount(viewKey);
  }

  public toJSON(): never {
    throw new Error("ViewOnlyAccount: refusing to serialize key material");
  }

  public async getViewKey(): Promise<Fr> {
    return this.viewKey;
  }

  public async getIncomingKey(index: bigint): Promise<Fr> {
    return deriveIncomingKey(this.viewKey, index);
  }

  public async getIncomingPub(index: bigint): Promise<Point<bigint>> {
    return publicKey(await this.getIncomingKey(index));
  }

  public async getPublicIncomingKey(index: bigint): Promise<Fr> {
    return derivePublicIncomingKey(this.viewKey, index);
  }

  public async getPublicIncomingPub(index: bigint): Promise<Point<bigint>> {
    return publicKey(await this.getPublicIncomingKey(index));
  }

  public async getSelfEphemeral(index: bigint): Promise<DerivedEph> {
    return deriveSelfEphemeral(this.viewKey, index);
  }

  public async getSelfSpendKey(): Promise<Fr> {
    if (this.#selfSpend === undefined) {
      this.#selfSpend = await deriveSelfSpendKey(this.viewKey);
    }
    return this.#selfSpend;
  }

  public async getSelfSpendPub(): Promise<Point<bigint>> {
    return publicKey(await this.getSelfSpendKey());
  }

  public async getStateKey(): Promise<Fr> {
    throw new Error(
      "ViewOnlyAccount: state key requires the root secret, which a read-only view-key account never has",
    );
  }

  public async canonicalIncomingAddress(
    startIndex: bigint,
  ): Promise<CanonicalAddress> {
    return canonicalIncomingAddress(this.viewKey, startIndex);
  }

  public async canonicalSelfTag(startIndex: bigint): Promise<CanonicalAddress> {
    return canonicalSelfTag(this.viewKey, startIndex);
  }

  public async canonicalPublicAddress(
    index: bigint,
  ): Promise<PublicIncomingAddress> {
    return canonicalPublicAddress(this.viewKey, index);
  }
}
