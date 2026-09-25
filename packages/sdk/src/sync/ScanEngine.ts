import { Point } from "@zk-kit/baby-jubjub";
import { NoteProcessor } from "./NoteProcessor.js";
import { UnprocessedEvent } from "./types.js";
import { LeanIMT } from "../merkle/LeanIMT.js";
import { toFr } from "../crypto/fields.js";
import { IKeyRepository, IUtxoRepository } from "../repositories.js";
import { ComplianceKeyRing } from "../note/complianceKeys.js";
import {
  MultisigScanner,
  type MultisigScanConfig,
  type MultisigNoteView,
} from "../frost/multisigScan.js";

/**
 * Ported from the reference EVM implementation's wallets package/src/sync/ScanEngine.ts. Master plan item C.5: replace the ethers
 * `Contract`/`EventLog` event source with the indexer's I-8 HTTP API. Two structural simplifications fall
 * out of that:
 *   1. No block-range/finality bookkeeping. The reference EVM implementation's `ScanEngine` floored to a deployment block and
 *      waited out a reorg-depth window because an EVM RPC can hand back logs from an unconfirmed fork.
 *      Kakure's indexer serves `GET /notes?from=<leaf_index>` -- leaf index is the pool's own commit
 *      order, and the indexer is responsible for only surfacing leaves behind a root it has already
 *      finalized. There is nothing left for this class to floor or wait out.
 *   2. No gap repair. The indexer's contract for `/notes?from=X` is "every `NoteInserted` from X onward,
 *      in leaf order" (I-8) -- unlike per-index EVM log queries, there is no way for this endpoint to skip
 *      leaves out from under a caller, so `repairTreeGap` (a real defence against `queryFilter` returning a
 *      subset) has no analogue here.
 *
 * `NoteProcessor` (trial decryption, compliance-key-ring aware) is unchanged. Single-key scanning uses it
 * directly; group (multisig) scanning is delegated to `frost/multisigScan.ts`'s `MultisigScanner`, which
 * consumes the exact same `UnprocessedEvent[]` shape.
 */

// I-4 / I-8 `NoteInserted`, as served by `GET /notes?from=<leaf_index>`. Hex fields are `0x`-prefixed or
// bare big-endian hex; `toFr`/`BigInt` both accept either.
export interface IndexerNoteInserted {
  readonly leaf_index: number;
  readonly leaf: string;
  readonly eph_pub_x: string;
  readonly tag?: string | null;
  readonly cek_wrap?: string | null;
  readonly ciphertext: readonly string[];
  readonly root: string;
}

/** The one indexer read this class needs: I-8's `GET /notes?from=<leaf_index>`. Kept as an injected port
 *  (mirroring the reference EVM implementation's `ChainView` in `tx/ports.ts`) so tests can supply fixtures without an HTTP server. */
export interface NotesTransport {
  fetchNotes(fromLeafIndex: number): Promise<readonly IndexerNoteInserted[]>;
}

/** `GET /notes` against a real indexer (I-8). */
export function httpNotesTransport(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): NotesTransport {
  return {
    async fetchNotes(fromLeafIndex: number) {
      const res = await fetchFn(`${baseUrl}/notes?from=${fromLeafIndex}`);
      if (!res.ok) {
        throw new Error(`NotesTransport: GET /notes?from=${fromLeafIndex} -> HTTP ${res.status}`);
      }
      return (await res.json()) as IndexerNoteInserted[];
    },
  };
}

const DEFAULT_PROBE_EXTRA_WINDOW = 100;

function toUnprocessedEvent(n: IndexerNoteInserted): UnprocessedEvent {
  const isMemo = n.tag != null && n.cek_wrap != null;
  // `UnprocessedEvent["args"].tag`/`cekWrap` are optional under `exactOptionalPropertyTypes`, which
  // distinguishes an omitted key from one explicitly set to `undefined` -- so the memo-only fields are
  // spread in conditionally rather than always assigned.
  const memoFields = isMemo
    ? { tag: BigInt(n.tag as string), cekWrap: BigInt(n.cek_wrap as string) }
    : {};
  return {
    type: isMemo ? "NEW_MEMO" : "NEW_NOTE",
    blockNumber: n.leaf_index,
    txHash: n.root,
    args: {
      leafIndex: BigInt(n.leaf_index),
      commitment: n.leaf,
      ephemeralX: BigInt(n.eph_pub_x),
      packedCiphertext: [...n.ciphertext],
      ...memoFields,
    },
  };
}

export class ScanEngine {
  private readonly processor: NoteProcessor;
  private readonly lookaheadWindow: number;

  constructor(
    private readonly transport: NotesTransport,
    private readonly keyRepo: IKeyRepository,
    private readonly utxoRepo: IUtxoRepository,
    compliancePk: Point<bigint> | ComplianceKeyRing,
    private readonly merkleTree?: LeanIMT,
    lookaheadWindow = 20,
  ) {
    this.lookaheadWindow = lookaheadWindow;
    this.processor = new NoteProcessor(keyRepo, compliancePk);
  }

  public async sync(fromLeafIndex: number): Promise<void> {
    await this.scanPasses(fromLeafIndex, this.lookaheadWindow);
  }

  public async probe(
    fromLeafIndex: number,
    extraWindow: number = DEFAULT_PROBE_EXTRA_WINDOW,
  ): Promise<boolean> {
    const before = this.utxoRepo.getAllNotes().length;
    await this.scanPasses(fromLeafIndex, this.lookaheadWindow + extraWindow);
    return this.utxoRepo.getAllNotes().length > before;
  }

  private async scanPasses(fromLeafIndex: number, window: number): Promise<void> {
    await this.keyRepo.ensureSelfLookahead(window);
    await this.keyRepo.ensureIncomingLookahead(window);

    const notes = await this.transport.fetchNotes(fromLeafIndex);

    const maxPasses = 64;
    for (let pass = 0; pass < maxPasses; pass++) {
      await this.scanOnce(notes);
      const ext1 = await this.keyRepo.ensureSelfLookahead(window);
      const ext2 = await this.keyRepo.ensureIncomingLookahead(window);
      if (!ext1 && !ext2) break;
    }
  }

  private async scanOnce(notes: readonly IndexerNoteInserted[]): Promise<void> {
    for (const n of notes) {
      if (this.merkleTree && n.leaf_index === this.merkleTree.nextLeafIndex) {
        await this.merkleTree.insert(toFr(n.leaf));
      }
      const walletNote = await this.processor.process(toUnprocessedEvent(n));
      if (walletNote) {
        await this.utxoRepo.addNote(walletNote);
      }
    }
  }
}

/**
 * Group (multisig) scanning over the same indexer feed. Not a subclass of `ScanEngine`: `MultisigScanner`
 * already owns its own self/incoming lookahead windows and per-event `readNote` (see
 * `frost/multisigScan.ts`), so this replays the same lookahead-then-drain pass loop `ScanEngine` uses,
 * against `MultisigScanner`'s API rather than `NoteProcessor`'s.
 */
export class MultisigScanEngine {
  private constructor(
    private readonly transport: NotesTransport,
    private readonly scanner: MultisigScanner,
    private readonly lookaheadWindow: number,
  ) {}

  static async create(
    transport: NotesTransport,
    config: MultisigScanConfig,
    lookaheadWindow = 20,
  ): Promise<MultisigScanEngine> {
    const scanner = await MultisigScanner.create(config);
    return new MultisigScanEngine(transport, scanner, lookaheadWindow);
  }

  public async sync(fromLeafIndex: number): Promise<MultisigNoteView[]> {
    const notes = await this.transport.fetchNotes(fromLeafIndex);
    const events = notes.map(toUnprocessedEvent);
    const found: MultisigNoteView[] = [];

    const maxPasses = 64;
    for (let pass = 0; pass < maxPasses; pass++) {
      found.length = 0;
      for (const event of events) {
        const view = await this.scanner.readNote(event);
        if (view) found.push(view);
      }
      const ext1 = await this.scanner.ensureSelfLookahead(this.lookaheadWindow);
      const ext2 = await this.scanner.ensureIncomingLookahead(this.lookaheadWindow);
      if (!ext1 && !ext2) break;
    }
    return found;
  }
}
