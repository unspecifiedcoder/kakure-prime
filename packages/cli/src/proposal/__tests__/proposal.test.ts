import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bjjCiphersuite, verify } from "@kakure/sdk/frost";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../../dkg/ceremony.js";
import { aggregatePublicShareAt } from "../../dkg/publicShare.js";
import { aggregateProposal, createProposal, signProposal } from "../proposal.js";
import { deriveSessionKeyFromGvsDecimal } from "../../crypto/sessionSeal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Full `propose` -> `sign` (x2) -> `execute`'s aggregation half, against the fake coordinator.
 * Runs a real 2-of-2 DKG first (same as `dkg/__tests__/ceremony.test.ts`) so the FROST signing
 * below is over an ACTUAL threshold-shared key, then verifies the aggregated signature with
 * `@kakure/sdk/frost`'s own `verify` -- proof the state machine produces a real, chain-verifiable
 * FROST signature, not a mock.
 */
describe("propose -> sign -> aggregate over the fake coordinator", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("produces a FROST signature that verifies against the group's real gpk", async () => {
    const sessionId = Buffer.from(randomBytes(32)).toString("hex");
    const threshold = 2;
    const memberCount = 2;
    const context = 0x1234n;

    const seedA = randomBytes(32);
    const seedB = randomBytes(32);
    const pubA = ed25519.getPublicKey(seedA);
    const pubB = ed25519.getPublicKey(seedB);

    const [dkgA, dkgB] = await Promise.all([
      runDkgCeremony({
        coordinator: new CoordinatorClient(url),
        sessionId,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedA),
        ed25519PublicKey: new Uint8Array(pubA),
        context,
        maxRounds: 200,
      }),
      runDkgCeremony({
        coordinator: new CoordinatorClient(url),
        sessionId,
        threshold,
        memberCount,
        ed25519Seed: new Uint8Array(seedB),
        ed25519PublicKey: new Uint8Array(pubB),
        context,
        maxRounds: 200,
      }),
    ]);

    expect(dkgA.gpk).toEqual(dkgB.gpk);
    const gpk = dkgA.gpk;

    // Everyone can compute everyone's public share from the (public) dealer commitments.
    const dealerCommitmentsList = [...dkgA.dealerCommitments.values()];
    const publicShares = new Map(
      dkgA.participantIds.map((id) => [id.toString(), aggregatePublicShareAt(id, dealerCommitmentsList)]),
    );

    const proposalSessionId = sessionId; // proposals live on the group's session in this design
    const proposalId = "proposal-1";
    const messageHex = "0x" + (0xdeadbeefn).toString(16);

    // slice-2 F-2: both members independently combine the SAME canonical group view secret from
    // their (identical) DKG round-2 view-key contributions, then derive the SAME session-sealing
    // key from it -- exactly the real flow `commands/group.ts`'s `runGroupCeremony` establishes.
    const contribsA = [...dkgA.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
    const contribsB = [...dkgB.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
    const gvsA = await combineGroupViewContributions(contribsA, gpk);
    const gvsB = await combineGroupViewContributions(contribsB, gpk);
    expect(gvsA.toString()).toBe(gvsB.toString());
    const sessionKey = deriveSessionKeyFromGvsDecimal(gvsA.toString(), proposalSessionId);

    const proposerClient = new CoordinatorClient(url);
    await createProposal(proposerClient, proposalSessionId, sessionKey, {
      kind: "transfer",
      proposalId,
      messageHex,
      details: { note: "test transfer" },
    });

    const signerAClient = new CoordinatorClient(url);
    const signerBClient = new CoordinatorClient(url);

    await Promise.all([
      signProposal({
        coordinator: signerAClient,
        sessionId: proposalSessionId,
        sessionKey,
        proposalId,
        myId: dkgA.myId,
        mySecretShare: dkgA.mySecretShare,
        gpk,
        threshold,
        maxRounds: 200,
      }),
      signProposal({
        coordinator: signerBClient,
        sessionId: proposalSessionId,
        sessionKey,
        proposalId,
        myId: dkgB.myId,
        mySecretShare: dkgB.mySecretShare,
        gpk,
        threshold,
        maxRounds: 200,
      }),
    ]);

    const { signature, message } = await aggregateProposal({
      coordinator: new CoordinatorClient(url),
      sessionKey,
      sessionId: proposalSessionId,
      proposalId,
      gpk,
      threshold,
      publicShares,
      maxRounds: 10,
    });

    const ok = await verify(bjjCiphersuite, gpk, message, signature);
    expect(ok).toBe(true);
  });
});
