import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { interpolateAtZero, scalarBaseMul } from "@kakure/sdk/tss";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../ceremony.js";

describe("runDkgCeremony against the fake coordinator (I-7 contract)", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("2 simulated members reach the same gpk and threshold shares that reconstruct gpk", async () => {
    const sessionId = Buffer.from(randomBytes(32)).toString("hex");
    const threshold = 2;
    const memberCount = 2;
    const context = 0xabcdefn;

    const seedA = randomBytes(32);
    const seedB = randomBytes(32);
    const pubA = ed25519.getPublicKey(seedA);
    const pubB = ed25519.getPublicKey(seedB);

    const clientA = new CoordinatorClient(url);
    const clientB = new CoordinatorClient(url);

    const [resultA, resultB] = await Promise.all([
      runDkgCeremony({
        coordinator: clientA,
        sessionId,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedA),
        ed25519PublicKey: new Uint8Array(pubA),
        context,
        maxRounds: 200,
      }),
      runDkgCeremony({
        coordinator: clientB,
        sessionId,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedB),
        ed25519PublicKey: new Uint8Array(pubB),
        context,
        maxRounds: 200,
      }),
    ]);

    expect(resultA.gpk).toEqual(resultB.gpk);
    expect(resultA.participantIds).toEqual(resultB.participantIds);
    expect(resultA.myId).not.toBe(resultB.myId);

    // Reconstruct the group secret from both members' shares via Lagrange interpolation at x=0
    // over the full 2-of-2 quorum, and confirm `reconstructed * G == gpk` -- the real end-to-end
    // proof that both members hold a genuine, consistent Shamir sharing of the same secret.
    const reconstructed = interpolateAtZero(
      new Map([
        [resultA.myId, resultA.mySecretShare],
        [resultB.myId, resultB.mySecretShare],
      ]),
      resultA.participantIds,
    );
    expect(scalarBaseMul(reconstructed)).toEqual(resultA.gpk);
    expect(resultA.gpk[0]).not.toBe(0n);

    // Each dealer's r_i (the group-view-key contribution combined by commands/group.ts via
    // @kakure/sdk/tss's combineGroupViewContributions) is broadcast identically to every
    // recipient inside its sealed box -- both members must have decrypted the SAME r_i per dealer.
    expect(resultA.viewContributions.size).toBe(2);
    expect(resultB.viewContributions.size).toBe(2);
    for (const [dealerId, rA] of resultA.viewContributions) {
      const rB = resultB.viewContributions.get(dealerId);
      expect(rB).toBeDefined();
      expect(Buffer.from(rA).toString("hex")).toBe(Buffer.from(rB!).toString("hex"));
      expect(rA.length).toBe(32);
    }
  });
});
