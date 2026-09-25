import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../ceremony.js";

const SESSION = "session-f2-dkg2";

/**
 * slice-2 F-2: the round-2 "dkg2" envelope's OUTER (unsealed) JSON must never carry `commitments`
 * (Feldman constant terms, from which `gpk = Σ dealers commitments[0]` is directly computable --
 * exactly the value spec §1/§5 says must be invisible to the coordinator) or `pop`. They now live
 * only inside each recipient's sealed box.
 */
describe("slice-2 F-2: round-2 dealer envelopes carry no commitments in the clear", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("the plaintext dkg2 envelope has no `commitments`/`pop` field", async () => {
    const threshold = 2;
    const memberCount = 2;
    const context = 0x9999n;
    const seedA = randomBytes(32);
    const seedB = randomBytes(32);

    await Promise.all([
      runDkgCeremony({
        coordinator: new CoordinatorClient(url),
        sessionId: SESSION,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedA),
        ed25519PublicKey: new Uint8Array(ed25519.getPublicKey(seedA)),
        context,
        maxRounds: 200,
      }),
      runDkgCeremony({
        coordinator: new CoordinatorClient(url),
        sessionId: SESSION,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedB),
        ed25519PublicKey: new Uint8Array(ed25519.getPublicKey(seedB)),
        context,
        maxRounds: 200,
      }),
    ]);

    const dkg2 = fake.envelopes(SESSION).filter((e) => e.kind === "dkg2");
    expect(dkg2.length).toBeGreaterThan(0);
    for (const e of dkg2) {
      const outer = JSON.parse(Buffer.from(e.ciphertext, "base64").toString("utf8")) as Record<string, unknown>;
      expect(outer).not.toHaveProperty("commitments");
      expect(outer).not.toHaveProperty("pop");
      // Only routing metadata + opaque per-recipient boxes are visible to the coordinator.
      expect(Object.keys(outer).sort()).toEqual(["boxes", "dealerId", "kind", "senderX25519PubHex"]);
      for (const box of Object.values(outer.boxes as Record<string, string>)) {
        expect(() => JSON.parse(Buffer.from(box, "base64").toString("utf8"))).toThrow();
      }
    }
  });
});
