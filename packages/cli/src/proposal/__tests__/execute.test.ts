import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransactionInstruction, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../../dkg/ceremony.js";
import { aggregatePublicShareAt } from "../../dkg/publicShare.js";
import { createProposal, signProposal } from "../proposal.js";
import { executeProposal } from "../execute.js";
import { deriveSessionKeyFromGvsDecimal } from "../../crypto/sessionSeal.js";

describe("executeProposal dry-run against fakes (no validator)", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("aggregates, calls the fake prover, and builds instructions via the fake TxBuilder callback", async () => {
    const sessionId = Buffer.from(randomBytes(32)).toString("hex");
    const threshold = 2;
    const memberCount = 2;
    const context = 0x5555n;

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

    const dealerCommitmentsList = [...dkgA.dealerCommitments.values()];
    const publicShares = new Map(
      dkgA.participantIds.map((id) => [id.toString(), aggregatePublicShareAt(id, dealerCommitmentsList)]),
    );

    const contribsA = [...dkgA.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
    const gvsA = await combineGroupViewContributions(contribsA, dkgA.gpk);
    const sessionKey = deriveSessionKeyFromGvsDecimal(gvsA.toString(), sessionId);

    const proposalId = "proposal-exec-1";
    await createProposal(new CoordinatorClient(url), sessionId, sessionKey, {
      kind: "withdraw",
      proposalId,
      messageHex: "0x" + (0xfeedn).toString(16),
      details: { amount: "42" },
    });

    await Promise.all([
      signProposal({
        coordinator: new CoordinatorClient(url),
        sessionId,
        sessionKey,
        proposalId,
        myId: dkgA.myId,
        mySecretShare: dkgA.mySecretShare,
        gpk: dkgA.gpk,
        threshold,
        maxRounds: 200,
      }),
      signProposal({
        coordinator: new CoordinatorClient(url),
        sessionId,
        sessionKey,
        proposalId,
        myId: dkgB.myId,
        mySecretShare: dkgB.mySecretShare,
        gpk: dkgB.gpk,
        threshold,
        maxRounds: 200,
      }),
    ]);

    let proveCalledWith: Record<string, unknown> | undefined;
    const fakeBundle = { proof: new Uint8Array([1, 2, 3]), publicInputs: [new Uint8Array(32)] };
    const fakeProver = {
      async prove(inputs: Record<string, unknown>) {
        proveCalledWith = inputs;
        return fakeBundle;
      },
    };

    const result = await executeProposal({
      coordinator: new CoordinatorClient(url),
      sessionId,
      sessionKey,
      proposalId,
      gpk: dkgA.gpk,
      threshold,
      publicShares,
      prover: fakeProver,
      buildInputs: (signature, proposal) => ({
        frost_z: signature.z.toString(),
        amount: (proposal.details as { amount: string }).amount,
      }),
      buildInstructions: (bundle) => [
        new TransactionInstruction({
          programId: PublicKey.default,
          keys: [],
          data: Buffer.from(bundle.proof),
        }),
      ],
    });

    expect(proveCalledWith).toEqual({ frost_z: expect.any(String), amount: "42" });
    expect(result.bundle).toBe(fakeBundle);
    expect(result.instructions).toHaveLength(1);
    expect(result.signature).toBeUndefined(); // dry run: no `send` supplied
  });
});
