import { beforeEach, describe, expect, it } from "vitest";
import type { ChainSource, RawTransaction, SignatureInfo } from "../chain/types.js";
import { IndexerStore } from "../db/store.js";
import { DEFAULT_KAKURE_POOL_IDL } from "../events/idl.js";
import { LeanIMT } from "../tree/leanImt.js";
import { Ingestor } from "./ingest.js";
import { LogTruncationError } from "./errors.js";
import {
  noteInsertedLogLine,
  nullifierSpentLogLine,
  wrapInProgramInvocation,
} from "../__tests__/fixtures/events.js";

const PROGRAM_ID = "Poo1111111111111111111111111111111111111";
const OTHER_PROGRAM_ID = "Other11111111111111111111111111111111111";

function poolLogs(lines: string[]): string[] {
  return wrapInProgramInvocation(PROGRAM_ID, lines);
}

/** In-memory fake honoring `until` the same way real `getSignaturesForAddress` does. */
class FakeChainSource implements ChainSource {
  private readonly signatures: SignatureInfo[] = []; // newest-first, like the real RPC
  private readonly txs = new Map<string, RawTransaction>();
  private logsCallback: ((info: SignatureInfo) => void) | null = null;

  /** Append a new signature+tx as if it just landed (prepended so it's "newest"). */
  addTransaction(tx: RawTransaction): void {
    this.signatures.unshift({ signature: tx.signature, slot: tx.slot, err: tx.err });
    this.txs.set(tx.signature, tx);
  }

  emitLive(tx: RawTransaction): void {
    this.addTransaction(tx);
    this.logsCallback?.({ signature: tx.signature, slot: tx.slot, err: tx.err });
  }

  async getSignaturesForAddress(
    _address: string,
    opts?: { before?: string; until?: string; limit?: number },
  ): Promise<SignatureInfo[]> {
    if (!opts?.until) return [...this.signatures];
    const idx = this.signatures.findIndex((s) => s.signature === opts.until);
    return idx === -1 ? [...this.signatures] : this.signatures.slice(0, idx);
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    return this.txs.get(signature) ?? null;
  }

  onLogs(_address: string, callback: (info: SignatureInfo) => void): () => void {
    this.logsCallback = callback;
    return () => {
      this.logsCallback = null;
    };
  }
}

describe("Ingestor", () => {
  let chain: FakeChainSource;
  let store: IndexerStore;
  let tree: LeanIMT;
  let ingestor: Ingestor;

  beforeEach(() => {
    chain = new FakeChainSource();
    store = new IndexerStore();
    tree = new LeanIMT(32);
    ingestor = new Ingestor({ chain, store, tree, idl: DEFAULT_KAKURE_POOL_IDL, programId: PROGRAM_ID });
  });

  it("backfill decodes NoteInserted/NullifierSpent events into the store and tree", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 10,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    chain.addTransaction({
      signature: "sig2",
      slot: 11,
      err: null,
      logMessages: poolLogs([nullifierSpentLogLine(0x09)]),
    });

    await ingestor.backfill();

    const notes = store.getNotesFrom(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.leafIndex).toBe(0);
    expect(tree.nextLeafIndex).toBe(1);
    expect(store.isNullifierSpent(`0x${"09".repeat(32)}`)).toBe(true);
    expect(store.getCursor()).toEqual({ lastSignature: "sig2", lastSlot: 11 });
  });

  it("ignores Program data lines from other programs and non-event log lines", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 5,
      err: null,
      logMessages: [
        ...wrapInProgramInvocation(OTHER_PROGRAM_ID, [noteInsertedLogLine({ leafIndex: 0n, leafByte: 1 })]),
        `Program ${PROGRAM_ID} invoke [1]`,
        "Program log: nothing to see here",
        `Program ${PROGRAM_ID} success`,
      ],
    });
    await ingestor.backfill();
    expect(store.getNotesFrom(0)).toHaveLength(0);
  });

  it("live tail appends events after backfill", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 1,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await ingestor.backfill();

    const unsubscribe = ingestor.startLiveTail();
    chain.emitLive({
      signature: "sig2",
      slot: 2,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 1n, leafByte: 0x02 })]),
    });
    // processSignature is async (fire-and-forget in startLiveTail); flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();

    expect(store.getNotesFrom(0)).toHaveLength(2);
    expect(tree.nextLeafIndex).toBe(2);
  });

  // slice-2 F-4: a truncated log drops every later line, including the `NoteInserted` event AND
  // the `Program … success` bracket line -- there is no way to tell "no event" from "an event,
  // then the cut" from the logs alone, so the only safe behavior is to halt loudly rather than
  // skip past it (silently desyncing the mirror forever) or guess at recovery. Per the explicit
  // coordinator directive this replaces the base finding's "recover the leaf from instruction
  // data" spec with "fail loudly, not skip".
  it("halts instead of advancing the cursor past a truncated log", async () => {
    chain.addTransaction({
      signature: "sigT",
      slot: 7,
      err: null,
      logMessages: [`Program ${PROGRAM_ID} invoke [1]`, "Log truncated"],
    });

    await expect(ingestor.backfill()).rejects.toThrow(LogTruncationError);

    // The cursor must NOT have advanced past the truncated signature -- a retry (e.g. after an
    // operator reconciles) must not skip it.
    expect(store.getCursor()).toEqual({ lastSignature: null, lastSlot: 0 });
    expect(tree.nextLeafIndex).toBe(0);
    expect(ingestor.halted).toBeInstanceOf(LogTruncationError);
  });

  it("halts and unsubscribes the live tail on a truncated log instead of logging and continuing", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 1,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await ingestor.backfill();
    expect(ingestor.halted).toBeUndefined();

    ingestor.startLiveTail();
    chain.emitLive({
      signature: "sigT",
      slot: 2,
      err: null,
      logMessages: [`Program ${PROGRAM_ID} invoke [1]`, "Log truncated"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ingestor.halted).toBeInstanceOf(LogTruncationError);
    // The mirror must still reflect only the pre-truncation state -- the truncated tx's (unknown)
    // events must never be silently applied.
    expect(tree.nextLeafIndex).toBe(1);

    // The subscription tore itself down: a further live event must not be processed.
    chain.emitLive({
      signature: "sig3",
      slot: 3,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 1n, leafByte: 0x02 })]),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tree.nextLeafIndex).toBe(1);
  });

  it("a second backfill with an unchanged cursor does not double-insert", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 1,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await ingestor.backfill();
    await ingestor.backfill(); // no new signatures beyond the cursor

    expect(store.getNotesFrom(0)).toHaveLength(1);
    expect(tree.nextLeafIndex).toBe(1);
  });

  it("backfill skips a failed transaction's events even though its logs would otherwise decode a NoteInserted", async () => {
    // Real-world motivation (F-4/workstream L note): a failed transaction never lands on chain --
    // the runtime reverts every state change (and the whole log buffer) if ANY instruction fails,
    // including the verifier CPI kakure_pool's spend ixs gate every insert/nullifier-spend behind.
    // So it is always safe to move `NoteInserted`/`NullifierSpent` emission earlier in a handler
    // (even before the verifier CPI) as long as ingestion never indexes a failed tx's logs -- this
    // pins that invariant with a `meta.err != null` fixture whose log lines DO contain a decodable
    // event, proving the skip is what keeps it out, not merely "there was nothing to decode".
    chain.addTransaction({
      signature: "sig-failed",
      slot: 1,
      err: { InstructionError: [0, "Custom" as unknown as never] },
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await ingestor.backfill();
    expect(store.getNotesFrom(0)).toHaveLength(0);
    expect(tree.nextLeafIndex).toBe(0);
  });

  it("live tail skips a failed transaction's events the same way", async () => {
    const unsubscribe = ingestor.startLiveTail();
    chain.emitLive({
      signature: "sig-failed-live",
      slot: 1,
      err: { InstructionError: [0, "Custom" as unknown as never] },
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    expect(store.getNotesFrom(0)).toHaveLength(0);
    expect(tree.nextLeafIndex).toBe(0);
  });

  it("hydrateTree rebuilds the mirror from previously persisted notes", async () => {
    chain.addTransaction({
      signature: "sig1",
      slot: 1,
      err: null,
      logMessages: poolLogs([noteInsertedLogLine({ leafIndex: 0n, leafByte: 0x01 })]),
    });
    await ingestor.backfill();

    const freshTree = new LeanIMT(32);
    const restarted = new Ingestor({
      chain,
      store,
      tree: freshTree,
      idl: DEFAULT_KAKURE_POOL_IDL,
      programId: PROGRAM_ID,
    });
    restarted.hydrateTree();
    expect(freshTree.nextLeafIndex).toBe(1);
    expect(freshTree.getRoot()).toBe(tree.getRoot());
  });
});
