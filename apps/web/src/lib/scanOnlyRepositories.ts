import { Fr, IDarkAccount, isEvenY, publicKey, type Note } from "@kakure/sdk";

/**
 * `@kakure/sdk` exports `ScanEngine`/`MultisigScanEngine` (I-8 consumers) but not the concrete
 * `KeyRepository`/`UtxoRepository` it was ported with, nor the `IKeyRepository`/`IUtxoRepository`
 * interfaces those satisfy (`packages/sdk/src/state/KeyRepository.ts`, `state/UtxoRepository.ts`,
 * `repositories.ts` are all internal to the package -- see `src/index.ts`). This file is a read-only-safe
 * reimplementation of just enough of the same shape (structurally typed against `ScanEngine`'s
 * constructor, since the interfaces themselves are not importable) for a browser scanner:
 *
 *   - No minting: `nextSelfEphemeral`/`nextIncomingAddress` (issuing NEW addresses to receive future
 *     payments) are never called by `ScanEngine.sync`, so they simply refuse -- a read-only dashboard has
 *     no business minting anything.
 *   - Same self/incoming lookahead + tag-matching algorithm as `KeyRepository`, ported by hand from
 *     `packages/sdk/src/state/KeyRepository.ts` (read, not copied verbatim, to drop the mint-only paths).
 *
 * Flagged in the workstream F report: `@kakure/sdk` should export `KeyRepository`, `UtxoRepository`,
 * `WalletNote` and the `IKeyRepository`/`IUtxoRepository` interfaces from its root entrypoint so
 * downstream read-only consumers (this dashboard, any future block explorer) don't need to re-derive this
 * logic.
 */

const MAX_INDEX_ROLL = 256;

// Structurally identical to the sdk's internal `WalletNote` (`state/types.ts`, not exported from
// `@kakure/sdk`'s root -- see the file doc comment) so `ScanEngine`'s `utxoRepo.addNote(WalletNote)` call
// is accepted without importing a type this package cannot see.
export interface ScanOnlyNote {
  readonly note: Note;
  readonly commitment: Fr;
  readonly leafIndex: number;
  readonly nullifier: Fr;
  readonly spendScalar: Fr;
  readonly isIncoming: boolean;
  readonly derivationIndex: number | bigint;
  spent: boolean;
}

function tagKey(x: bigint): string {
  return new Fr(x).toString();
}

export class ScanOnlyKeyRepository {
  #selfScanIndex = 0;
  #incomingScanIndex = 0;
  #highestMatchedSelf = -1;
  #highestMatchedIncoming = -1;
  #selfMap = new Map<string, { eph: Fr; index: number }>();
  #incomingMap = new Map<string, { inKey: Fr; index: number }>();

  constructor(private readonly account: IDarkAccount) {}

  get selfScanIndex(): number {
    return this.#selfScanIndex;
  }
  get incomingScanIndex(): number {
    return this.#incomingScanIndex;
  }

  getSelfSpendScalar(): Promise<Fr> {
    return this.account.getSelfSpendKey();
  }
  getSelfSpendPub() {
    return this.account.getSelfSpendPub();
  }

  nextSelfEphemeral(): Promise<never> {
    return Promise.reject(
      new Error("ScanOnlyKeyRepository: read-only dashboard never mints new self ephemerals"),
    );
  }
  nextIncomingAddress(): Promise<never> {
    return Promise.reject(
      new Error("ScanOnlyKeyRepository: read-only dashboard never issues new incoming addresses"),
    );
  }

  async ensureSelfLookahead(window: number): Promise<boolean> {
    const target = Math.max(this.#selfScanIndex, this.#highestMatchedSelf + 1 + window);
    let advanced = false;
    while (this.#selfScanIndex < target) {
      await this.#registerSelf(this.#selfScanIndex++);
      advanced = true;
    }
    return advanced;
  }

  async ensureIncomingLookahead(window: number): Promise<boolean> {
    const target = Math.max(this.#incomingScanIndex, this.#highestMatchedIncoming + 1 + window);
    let advanced = false;
    while (this.#incomingScanIndex < target) {
      await this.#registerIncoming(this.#incomingScanIndex++);
      advanced = true;
    }
    return advanced;
  }

  matchSelfTag(tag: bigint | string): { eph: Fr; index: number } | null {
    const match = this.#selfMap.get(tagKey(BigInt(tag))) ?? null;
    if (match && match.index > this.#highestMatchedSelf) {
      this.#highestMatchedSelf = match.index;
    }
    return match;
  }

  matchIncomingTag(tag: bigint | string): { inKey: Fr; index: number } | null {
    const match = this.#incomingMap.get(tagKey(BigInt(tag))) ?? null;
    if (match && match.index > this.#highestMatchedIncoming) {
      this.#highestMatchedIncoming = match.index;
    }
    return match;
  }

  recordIncomingMatch(index: number): void {
    if (index > this.#highestMatchedIncoming) this.#highestMatchedIncoming = index;
  }

  getState() {
    return {
      selfMintCounter: 0,
      selfScanIndex: this.#selfScanIndex,
      incomingIssueCounter: 0,
      incomingScanIndex: this.#incomingScanIndex,
      highestMatchedSelf: this.#highestMatchedSelf,
      highestMatchedIncoming: this.#highestMatchedIncoming,
    };
  }

  async restore(): Promise<void> {
    // Not needed by a stateless browser session: every connect starts a fresh scan from leaf 0.
  }

  async #registerSelf(index: number): Promise<void> {
    if (index >= MAX_INDEX_ROLL * 4000) return; // sanity bound, matches KeyRepository's MAX_KEY_INDEX order
    const eph = await this.account.getSelfEphemeral(BigInt(index));
    const ephPub = publicKey(eph);
    if (!isEvenY(ephPub)) return;
    const key = tagKey(ephPub[0]);
    if (!this.#selfMap.has(key)) this.#selfMap.set(key, { eph, index });
  }

  async #registerIncoming(index: number): Promise<void> {
    const inKey = await this.account.getIncomingKey(BigInt(index));
    const inPub = publicKey(inKey);
    if (!isEvenY(inPub)) return;
    const key = tagKey(inPub[0]);
    if (!this.#incomingMap.has(key)) this.#incomingMap.set(key, { inKey, index });
  }
}

export class ScanOnlyUtxoRepository {
  #notes = new Map<string, ScanOnlyNote>();

  async addNote(note: ScanOnlyNote): Promise<void> {
    const key = note.nullifier.toString();
    const existing = this.#notes.get(key);
    if (existing) {
      this.#notes.set(key, { ...note, spent: existing.spent || note.spent });
      return;
    }
    this.#notes.set(key, note);
  }

  markSpent(nullifier: string | Fr): boolean {
    const key = nullifier.toString();
    const note = this.#notes.get(key);
    if (note && !note.spent) {
      note.spent = true;
      return true;
    }
    return false;
  }

  getUnspentNotes(): ScanOnlyNote[] {
    return this.getAllNotes().filter((n) => !n.spent);
  }

  getAllNotes(): ScanOnlyNote[] {
    return Array.from(this.#notes.values());
  }

  getBalance(assetId?: Fr | bigint | string): bigint {
    const want =
      assetId === undefined
        ? undefined
        : typeof assetId === "bigint"
          ? assetId
          : typeof assetId === "string"
            ? BigInt(assetId)
            : assetId.toBigInt();
    let total = 0n;
    for (const note of this.getUnspentNotes()) {
      if (want !== undefined && note.note.assetId.toBigInt() !== want) continue;
      total += note.note.value;
    }
    return total;
  }
}
