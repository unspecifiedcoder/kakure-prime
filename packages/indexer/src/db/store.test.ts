import { beforeEach, describe, expect, it } from "vitest";
import { IndexerStore } from "./store.js";

describe("IndexerStore", () => {
  let store: IndexerStore;

  beforeEach(() => {
    store = new IndexerStore();
  });

  it("round-trips a note", () => {
    store.insertNote({
      leafIndex: 1,
      leaf: "0xleaf",
      ephPubX: "0xeph",
      tag: "0xtag",
      cekWrap: "0xcek",
      ciphertext: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7"],
      root: "0xroot1",
      slot: 100,
    });
    const notes = store.getNotesFrom(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      leafIndex: 1,
      leaf: "0xleaf",
      ephPubX: "0xeph",
      tag: "0xtag",
      cekWrap: "0xcek",
      ciphertext: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7"],
      root: "0xroot1",
      slot: 100,
    });
  });

  it("filters notes by from=leaf_index", () => {
    for (let i = 0; i < 5; i++) {
      store.insertNote({
        leafIndex: i,
        leaf: `0xleaf${i}`,
        ephPubX: "0xeph",
        tag: null,
        cekWrap: null,
        ciphertext: ["0", "0", "0", "0", "0", "0", "0"],
        root: `0xroot${i}`,
        slot: i,
      });
    }
    expect(store.getNotesFrom(3).map((n) => n.leafIndex)).toEqual([3, 4]);
  });

  it("round-trips nullifiers and reports spent status", () => {
    expect(store.isNullifierSpent("0xnf1")).toBe(false);
    store.insertNullifier("0xnf1", 42);
    expect(store.isNullifierSpent("0xnf1")).toBe(true);
    expect(store.isNullifierSpent("0xnf2")).toBe(false);
  });

  // slice-2 F-5: bulk range query for wallets to check membership locally instead of one
  // per-note round trip.
  it("getNullifiersFrom returns every spent nullifier since a slot, in slot order", () => {
    store.insertNullifier("0xnfA", 5);
    store.insertNullifier("0xnfB", 10);
    store.insertNullifier("0xnfC", 20);
    expect(store.getNullifiersFrom(0)).toEqual(["0xnfA", "0xnfB", "0xnfC"]);
    expect(store.getNullifiersFrom(10)).toEqual(["0xnfB", "0xnfC"]);
    expect(store.getNullifiersFrom(21)).toEqual([]);
  });

  it("tracks a ring buffer of roots and returns the latest", () => {
    store.pushRoot("0xr0", 1, 10);
    store.pushRoot("0xr1", 2, 11);
    store.pushRoot("0xr2", 3, 12);
    expect(store.getLatestRoot()).toEqual({
      cursor: 2,
      root: "0xr2",
      nextLeafIndex: 3,
      slot: 12,
    });
    expect(store.listRoots().map((r) => r.root)).toEqual(["0xr0", "0xr1", "0xr2"]);
  });

  it("breaks a slot tie by true insertion order (regression: SolanaChainSource.onLogs used to hardcode slot 0 for every live-tail event)", () => {
    // Before that fix, every live-tail-observed root push landed here with slot=0, so
    // `getLatestRoot()` could not tell the second push was actually the latest one -- it needs a
    // tiebreaker, not just `ORDER BY slot DESC`.
    store.pushRoot("0xgenesis", 1, 0);
    store.pushRoot("0xdeposit", 2, 0);
    expect(store.getLatestRoot()).toEqual({
      cursor: 1,
      root: "0xdeposit",
      nextLeafIndex: 2,
      slot: 0,
    });
  });

  it("round-trips compliance key history", () => {
    store.insertComplianceKey({ version: 0, x: "0xa", y: "0xb", fromSlot: 5 });
    store.insertComplianceKey({ version: 1, x: "0xc", y: "0xd", fromSlot: 50 });
    expect(store.listComplianceKeys()).toEqual([
      { version: 0, x: "0xa", y: "0xb", fromSlot: 5 },
      { version: 1, x: "0xc", y: "0xd", fromSlot: 50 },
    ]);
  });

  it("round-trips the ingestion cursor", () => {
    expect(store.getCursor()).toEqual({ lastSignature: null, lastSlot: 0 });
    store.setCursor({ lastSignature: "sig123", lastSlot: 99 });
    expect(store.getCursor()).toEqual({ lastSignature: "sig123", lastSlot: 99 });
  });
});
