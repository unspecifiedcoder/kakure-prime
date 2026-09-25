import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { readEncryptedJsonFile } from "../../keystore.js";
import { runGroupCeremony, type GroupRecord } from "../group.js";

describe("group create / join over the fake coordinator", () => {
  let fake: FakeCoordinator;
  let url: string;
  let dir: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
    dir = await mkdtemp(join(tmpdir(), "kakure-group-test-"));
  });
  afterEach(async () => {
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("`group create` + `group join` produce the same gpk and a usable encrypted group record", async () => {
    const creator = Keypair.generate();
    const joiner = Keypair.generate();

    // In the real CLI, `group create` generates and prints the session id; `group join
    // <session>` supplies it. The test agrees on one out of band and starts both concurrently.
    const sessionId = "ab".repeat(32);
    const [creatorRecord, joinerRecord] = await Promise.all([
      runGroupCeremony({
        coordinatorUrl: url,
        sessionId,
        threshold: 2,
        memberCount: 2,
        keypair: creator,
        groupStorePath: join(dir, "creator.json"),
        passphrase: "creator-pass",
        maxRounds: 200,
      }),
      runGroupCeremony({
        coordinatorUrl: url,
        sessionId,
        threshold: 2,
        memberCount: 2,
        keypair: joiner,
        groupStorePath: join(dir, "joiner.json"),
        passphrase: "joiner-pass",
        maxRounds: 200,
      }),
    ]);

    expect(creatorRecord.gpk).toEqual(joinerRecord.gpk);
    expect(creatorRecord.myId).not.toBe(joinerRecord.myId);
    // CANONICAL group view key: both members combine the SAME set of DKG round-2 `r_i`
    // contributions (via @kakure/sdk/tss's combineGroupViewContributions) into the same `gvs`, and
    // therefore derive the IDENTICAL (v, V) -- unlike the deprecated per-account
    // `deriveGroupViewKey`, which gave every non-creator member a different view key.
    expect(creatorRecord.groupViewKey.gvs).toBe(joinerRecord.groupViewKey.gvs);
    expect(creatorRecord.groupViewKey.v).toBe(joinerRecord.groupViewKey.v);
    expect(creatorRecord.groupViewKey.V).toEqual(joinerRecord.groupViewKey.V);
    expect(creatorRecord.groupViewKey.V.x).not.toBe("0");

    const persisted = await readEncryptedJsonFile<GroupRecord>(join(dir, "creator.json"), "creator-pass");
    expect(persisted.gpk).toEqual(creatorRecord.gpk);
  });
});
