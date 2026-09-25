import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { IndexerStore } from "../db/store.js";
import { LeanIMT } from "../tree/leanImt.js";
import { buildIndexerApi } from "./server.js";
import { fieldToHex } from "../tree/poseidonV1.js";
import type { ChainSource, RawTransaction, SignatureInfo } from "../chain/types.js";
import { DEFAULT_KAKURE_POOL_IDL } from "../events/idl.js";
import { Ingestor } from "../ingest/ingest.js";

const PROGRAM_ID = "Poo1111111111111111111111111111111111111";

/** Minimal `ChainSource` that returns one transaction with a truncated log. */
class TruncatedLogChainSource implements ChainSource {
  async getSignaturesForAddress(): Promise<SignatureInfo[]> {
    return [{ signature: "sigT", slot: 7, err: null }];
  }
  async getTransaction(signature: string): Promise<RawTransaction | null> {
    return { signature, slot: 7, err: null, logMessages: [`Program ${PROGRAM_ID} invoke [1]`, "Log truncated"] };
  }
  onLogs(): () => void {
    return () => {};
  }
}

describe("indexer HTTP API (I-8)", () => {
  let store: IndexerStore;
  let tree: LeanIMT;
  let app: FastifyInstance;

  beforeEach(() => {
    store = new IndexerStore();
    tree = new LeanIMT(4);
    app = buildIndexerApi({ store, tree });
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /root returns root, next_leaf_index and a 256-entry roots array", async () => {
    tree.insert(7n);
    store.pushRoot(fieldToHex(tree.getRoot()), tree.nextLeafIndex, 1);

    const res = await app.inject({ method: "GET", url: "/root" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.root).toBe(fieldToHex(tree.getRoot()));
    expect(body.next_leaf_index).toBe(1);
    expect(body.roots).toHaveLength(256);
    expect(body.roots[0]).toBe(fieldToHex(tree.getRoot()));
  });

  it("GET /root includes root_cursor (workstream G, additive to I-8): 0 before any root, then one past the latest written slot", async () => {
    const empty = await app.inject({ method: "GET", url: "/root" });
    expect(empty.json().root_cursor).toBe(0);

    tree.insert(7n);
    store.pushRoot(fieldToHex(tree.getRoot()), tree.nextLeafIndex, 1);
    const afterOne = await app.inject({ method: "GET", url: "/root" });
    // pushRoot's own internal cursor allocation is 0-based and increments per push (see
    // db/store.ts's pushRoot), so after exactly one push the on-chain-equivalent root_cursor
    // (one past the slot just written) is 1.
    expect(afterOne.json().root_cursor).toBe(1);

    tree.insert(9n);
    store.pushRoot(fieldToHex(tree.getRoot()), tree.nextLeafIndex, 2);
    const afterTwo = await app.inject({ method: "GET", url: "/root" });
    expect(afterTwo.json().root_cursor).toBe(2);
  });

  it("GET /root's root_cursor wraps mod 256, matching Pool::push_root's ring buffer", async () => {
    // pushRoot only needs SOME hex string and doesn't care whether it is a real tree root, so
    // synthesize 256 distinct ones directly rather than growing a real (depth-limited) LeanIMT.
    for (let i = 0; i < 256; i++) {
      store.pushRoot("0x" + (i + 1).toString(16).padStart(64, "0"), i + 1, i + 1);
    }
    const res = await app.inject({ method: "GET", url: "/root" });
    // 256 pushes fill the ring exactly once; the cursor wraps back to 0.
    expect(res.json().root_cursor).toBe(0);
  });

  it("GET /path/:leaf_index returns 32 siblings", async () => {
    tree.insert(7n);
    tree.insert(9n);

    const res = await app.inject({ method: "GET", url: "/path/0" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.siblings).toEqual([fieldToHex(9n), fieldToHex(0n), fieldToHex(0n), fieldToHex(0n)]);
  });

  it("GET /path/:leaf_index 404s for an out-of-bounds index", async () => {
    const res = await app.inject({ method: "GET", url: "/path/99" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /notes?from= returns NoteInserted rows from the given leaf index", async () => {
    store.insertNote({
      leafIndex: 0,
      leaf: "0x1",
      ephPubX: "0x2",
      tag: null,
      cekWrap: null,
      ciphertext: ["0", "0", "0", "0", "0", "0", "0"],
      root: "0xr0",
      slot: 1,
    });
    store.insertNote({
      leafIndex: 1,
      leaf: "0x3",
      ephPubX: "0x4",
      tag: "0x5",
      cekWrap: "0x6",
      ciphertext: ["1", "1", "1", "1", "1", "1", "1"],
      root: "0xr1",
      slot: 2,
    });

    const res = await app.inject({ method: "GET", url: "/notes?from=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      leaf_index: 1,
      leaf: "0x3",
      eph_pub_x: "0x4",
      tag: "0x5",
      cek_wrap: "0x6",
      ciphertext: ["1", "1", "1", "1", "1", "1", "1"],
      root: "0xr1",
    });
  });

  it("GET /nullifiers/:hex reports spent status", async () => {
    store.insertNullifier("0xdead", 5);
    const spent = await app.inject({ method: "GET", url: "/nullifiers/0xdead" });
    expect(spent.json()).toEqual({ spent: true });
    const unspent = await app.inject({ method: "GET", url: "/nullifiers/0xbeef" });
    expect(unspent.json()).toEqual({ spent: false });
  });

  // slice-2 F-5: bulk range endpoint so wallets check membership locally.
  it("GET /nullifiers?from_slot= returns every spent nullifier since that slot", async () => {
    store.insertNullifier("0xa1", 1);
    store.insertNullifier("0xb2", 5);
    const all = await app.inject({ method: "GET", url: "/nullifiers" });
    expect(all.json()).toEqual({ nullifiers: ["0xa1", "0xb2"] });
    const fromFive = await app.inject({ method: "GET", url: "/nullifiers?from_slot=5" });
    expect(fromFive.json()).toEqual({ nullifiers: ["0xb2"] });
  });

  it("GET /compliance returns key history in version order", async () => {
    store.insertComplianceKey({ version: 0, x: "0xa", y: "0xb", fromSlot: 1 });
    store.insertComplianceKey({ version: 1, x: "0xc", y: "0xd", fromSlot: 2 });
    const res = await app.inject({ method: "GET", url: "/compliance" });
    expect(res.json()).toEqual([
      { version: 0, x: "0xa", y: "0xb", from_slot: 1 },
      { version: 1, x: "0xc", y: "0xd", from_slot: 2 },
    ]);
  });

  // slice-2 F-4: once the ingestor has observed a truncated log, its leaf mirror can no longer be
  // trusted -- the mirror-derived endpoints must refuse to serve rather than answer with a
  // possibly-wrong index.
  describe("halted ingestor (truncated log observed, slice-2 F-4)", () => {
    it("GET /root and GET /path/:leaf_index return 503 once halted", async () => {
      const haltedIngestor = new Ingestor({
        chain: new TruncatedLogChainSource(),
        store,
        tree,
        idl: DEFAULT_KAKURE_POOL_IDL,
        programId: PROGRAM_ID,
      });
      await expect(haltedIngestor.backfill()).rejects.toThrow(/HALT/);
      expect(haltedIngestor.halted).toBeDefined();

      const haltedApp = buildIndexerApi({ store, tree, ingestor: haltedIngestor });
      const rootRes = await haltedApp.inject({ method: "GET", url: "/root" });
      expect(rootRes.statusCode).toBe(503);
      const pathRes = await haltedApp.inject({ method: "GET", url: "/path/0" });
      expect(pathRes.statusCode).toBe(503);
      await haltedApp.close();
    });

    it("omitting `ingestor` keeps pre-F-4 behavior (no 503 gate)", async () => {
      // `app` (from beforeEach) was built with no `ingestor` at all -- backward compatible.
      const res = await app.inject({ method: "GET", url: "/root" });
      expect(res.statusCode).toBe(200);
    });
  });
});
