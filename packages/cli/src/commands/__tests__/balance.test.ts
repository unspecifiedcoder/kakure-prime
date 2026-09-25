import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeIndexer } from "../../__tests__/fakes/fakeIndexer.js";
import { computeBalance } from "../balance.js";
import type { GroupRecord } from "../group.js";

describe("computeBalance against the fake indexer (I-8 contract)", () => {
  let fake: FakeIndexer;
  let url: string;

  beforeEach(async () => {
    fake = new FakeIndexer();
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("returns no rows when the indexer has no notes", async () => {
    const group: GroupRecord = {
      sessionId: "ab".repeat(32),
      threshold: 2,
      memberCount: 2,
      myId: "1",
      participantIds: ["1", "2"],
      gpk: { x: "12", y: "34" },
      mySecretShare: "1",
      groupViewKey: { gvs: "9", v: "5", V: { x: "6", y: "7" }, roll: "0" },
      dealerCommitments: {},
    };
    const rows = await computeBalance(url, group);
    expect(rows).toEqual([]);

    // slice-2 F-5: no per-note `/nullifiers/:hex` request -- the operator must not learn a
    // wallet's note set one lookup at a time.
    expect(fake.perNoteNullifierFetches).toEqual([]);
  });
});
