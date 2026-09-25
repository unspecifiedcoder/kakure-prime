import type { ChainSource } from "../chain/types.js";
import { decodeProgramDataLine, EventDecodeError } from "../events/decode.js";
import { programDataLinesFor } from "../events/logScope.js";
import type { KakurePoolIdl } from "../events/idl.js";
import { toDomainEvent, type KakurePoolEvent } from "../events/types.js";
import type { IndexerStore } from "../db/store.js";
import { LeanIMT } from "../tree/leanImt.js";
import { fieldFromHex, fieldToHex } from "../tree/poseidonV1.js";
import { LogTruncationError, logsWereTruncated } from "./errors.js";

export interface IngestorOptions {
  chain: ChainSource;
  store: IndexerStore;
  tree: LeanIMT;
  idl: KakurePoolIdl;
  programId: string;
}

/**
 * Drives the indexer's ingestion: `getSignaturesForAddress` backfill (oldest-first, persisting a
 * cursor so re-runs don't refetch), then a live `onLogs` tail. Decodes every `"Program data: "`
 * log line emitted while the pool program was the currently-executing program (see
 * `events/logScope.ts` -- `kakure_pool` is native `solana-program`, not Anchor, so events are
 * `sol_log_data` lines, not `emit_cpi!` instructions); non-event lines and decode failures are
 * skipped, not fatal.
 */
export class Ingestor {
  /**
   * Set the instant a `LogTruncationError` is observed (backfill or live tail) and never cleared:
   * the mirror's correctness from that signature on is unknown, so every subsequent read must be
   * refused (slice-2 F-4 -- "fail loudly, not skip"). Callers (the HTTP layer) should check this
   * before serving `/path`, `/root`, etc. and return 503 while it is set.
   */
  private _halted: LogTruncationError | undefined;

  constructor(private readonly opts: IngestorOptions) {}

  /** Set once a truncated log has been observed; the mirror must be treated as untrustworthy. */
  get halted(): LogTruncationError | undefined {
    return this._halted;
  }

  /** Rebuild the in-memory LeanIMT mirror from previously persisted notes (call once at startup). */
  hydrateTree(): void {
    const notes = this.opts.store.getNotesFrom(0);
    for (const note of notes) {
      this.opts.tree.insert(fieldFromHex(note.leaf));
    }
  }

  /**
   * Fetch and apply every signature newer than the persisted cursor, oldest-first. Throws (does
   * NOT catch-and-continue) `LogTruncationError`: a truncated log means events after the cut are
   * unrecoverable and the cursor must not advance past it, so the whole backfill halts rather than
   * silently skipping ahead with a desynced mirror.
   */
  async backfill(): Promise<void> {
    const cursor = this.opts.store.getCursor();
    const signatures = await this.opts.chain.getSignaturesForAddress(
      this.opts.programId,
      cursor.lastSignature ? { until: cursor.lastSignature } : undefined,
    );
    // getSignaturesForAddress returns newest-first; process chronologically.
    const chronological = [...signatures].reverse();
    for (const sig of chronological) {
      if (sig.err) continue;
      await this.processSignature(sig.signature, sig.slot);
    }
  }

  /**
   * Subscribe to live logs; returns an unsubscribe function. Most per-signature errors are logged
   * and the subscription keeps running (fire-and-forget) -- but a `LogTruncationError` is fatal:
   * it is logged as a HALT alert, `this.halted` is latched, and the subscription is torn down
   * immediately, rather than continuing to tail logs against a mirror that may already be one
   * leaf short (slice-2 F-4).
   */
  startLiveTail(): () => void {
    const unsubscribe = this.opts.chain.onLogs(this.opts.programId, (info) => {
      if (info.err) return;
      void this.processSignature(info.signature, info.slot).catch((err: unknown) => {
        if (err instanceof LogTruncationError) {
          this._halted = err;
          // eslint-disable-next-line no-console
          console.error("ALERT: kakure indexer live tail HALTED (truncated log detected)", err);
          unsubscribe();
          return;
        }
        // Fire-and-forget: other log processing errors must not crash the subscription.
        // eslint-disable-next-line no-console
        console.error("ingest: failed to process live signature", err);
      });
    });
    return unsubscribe;
  }

  private async processSignature(signature: string, slot: number): Promise<void> {
    const tx = await this.opts.chain.getTransaction(signature);
    if (!tx || tx.err) {
      this.opts.store.setCursor({ lastSignature: signature, lastSlot: slot });
      return;
    }
    // slice-2 F-4: a truncated log drops every line after the cut -- including the events this
    // loop is about to scan for AND the `Program … success` bracket line `programDataLinesFor`
    // relies on -- so there is no way to tell "zero events" from "some events, then the cut" from
    // the logs alone. Halt before touching the tree/store/cursor for this signature at all.
    if (logsWereTruncated(tx.logMessages)) {
      const err = new LogTruncationError(signature, slot);
      this._halted = err;
      throw err;
    }
    const lines = programDataLinesFor(tx.logMessages, this.opts.programId);
    for (const line of lines) {
      let decoded;
      try {
        decoded = decodeProgramDataLine(this.opts.idl, line);
      } catch (err) {
        if (err instanceof EventDecodeError) continue; // malformed or an event we don't decode
        throw err;
      }
      if (!decoded) continue;
      this.applyEvent(toDomainEvent(decoded), slot);
    }
    this.opts.store.setCursor({ lastSignature: signature, lastSlot: slot });
  }

  private applyEvent(event: KakurePoolEvent, slot: number): void {
    switch (event.name) {
      case "NoteInserted": {
        const root = this.opts.tree.insert(fieldFromHex(event.leaf));
        this.opts.store.insertNote({
          leafIndex: Number(event.leafIndex),
          leaf: event.leaf,
          ephPubX: event.ephPubX,
          tag: event.tag,
          cekWrap: event.cekWrap,
          ciphertext: event.ciphertext,
          root: fieldToHex(root),
          slot,
        });
        this.opts.store.pushRoot(fieldToHex(root), this.opts.tree.nextLeafIndex, slot);
        break;
      }
      case "NullifierSpent":
        this.opts.store.insertNullifier(event.nullifier, slot);
        break;
      case "ComplianceKeyRotated":
        this.opts.store.insertComplianceKey({
          version: event.newVersion,
          x: event.x,
          y: event.y,
          fromSlot: slot,
        });
        break;
    }
  }
}
