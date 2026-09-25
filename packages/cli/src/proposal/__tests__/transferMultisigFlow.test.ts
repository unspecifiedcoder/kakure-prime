import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Fr, InMemoryEphemeralCounterStore, deriveCek, computePsi, leaf } from "@kakure/sdk";
import { multisigOwner, deriveGroupViewKeyFromSecret, type MultisigNoteView } from "@kakure/sdk/frost";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import type { MerkleWitnessSource } from "@kakure/sdk/solana";
import { computeNullifier } from "@kakure/sdk";
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle, type ProverPort } from "@kakure/sdk/tx";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../../dkg/ceremony.js";
import { aggregatePublicShareAt } from "../../dkg/publicShare.js";
import { scalarBaseMul, type Point } from "@kakure/sdk/tss";
import { signProposal } from "../proposal.js";
import { deriveSessionKeyFromGvsDecimal } from "../../crypto/sessionSeal.js";
import { executeProposal } from "../execute.js";
import { assembleTransferMultisig } from "../assembleTransferMultisig.js";
import {
  buildTransferMultisigInputsFromProposal,
  createTransferMultisigProposal,
} from "../transferMultisigProposal.js";

const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];

/** Trivial witness source consistent with `old_note_index=0, old_note_path=[0;32]` (the same
 *  all-zero-sibling shape the prover's own KAT uses): with leafIndex 0 and every sibling zero,
 *  `foldPath` never mixes in a sibling, so the "root" is just the leaf itself. */
function zeroPathWitnessSource(): MerkleWitnessSource {
  return {
    async witnessFor(leaf: Fr) {
      return { leafIndex: 0, siblings: Array.from({ length: 32 }, () => new Fr(0n)), root: leaf };
    },
  };
}

describe("real transfer_multisig assembly -> propose -> sign -> execute (fake prover)", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("wires real note assembly + msg_transfer + FROST aggregate into a prove() call with the exact I-1 shape", async () => {
    const sessionId = Buffer.from(randomBytes(32)).toString("hex");
    const threshold = 2;
    const memberCount = 2;
    const context = 0x9999n;

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
    const gpk = dkgA.gpk;
    const dealerCommitmentsList = [...dkgA.dealerCommitments.values()];
    const publicShares = new Map(
      dkgA.participantIds.map((id) => [id.toString(), aggregatePublicShareAt(id, dealerCommitmentsList)]),
    );

    // A real multisig-owned note the group is about to spend (constructed the same way a mint would).
    const oldEph = new Fr(1234n);
    const oldCek = deriveCek(oldEph, [...COMPLIANCE_PK]);
    const oldPsi = await computePsi(oldCek);
    const owner = new Fr(await multisigOwner([...gpk]));
    const assetIdField = new Fr(0x1234567890123456789012345678901234567890n);
    const oldNoteBigint = {
      noteVersion: new Fr(1n),
      assetId: assetIdField,
      noteType: new Fr(1n),
      conditionsHash: new Fr(0n),
      value: 100n,
      owner,
      psi: oldPsi,
      parents: new Fr(0n),
    };
    const oldCommitment = await leaf(oldNoteBigint);
    const nullifier = await computeNullifier(oldPsi, new Fr(0n));
    const oldNoteView: MultisigNoteView = {
      note: oldNoteBigint,
      commitment: oldCommitment,
      leafIndex: 0,
      nullifier,
      isIncoming: false,
    };

    const recipientInPub = scalarBaseMul(7n);

    const gvs = await combineGroupViewContributions(
      [...dkgA.viewContributions].map(([id, r]) => ({ index: Number(id), r })),
      [...gpk],
    );
    const sessionKey = deriveSessionKeyFromGvsDecimal(gvs.toString(), sessionId);

    const assembled = await assembleTransferMultisig(
      { merkle: zeroPathWitnessSource(), counters: new InMemoryEphemeralCounterStore() },
      {
        gpk: [...gpk],
        v: (await deriveGroupViewKeyFromSecret(gvs, [...gpk])).v,
        memberId: dkgA.myId,
        compliancePk: [...COMPLIANCE_PK],
        oldNoteView,
        transferValue: 40n,
        recipientInPub: [...recipientInPub],
        recipientInKey: new Fr(7n),
        memoEph: new Fr(4n),
      },
    );

    expect(assembled.root.toBigInt()).toBe(oldCommitment.toBigInt());

    const proposalId = "transfer-multisig-1";
    await createTransferMultisigProposal(new CoordinatorClient(url), sessionId, sessionKey, proposalId, assembled);

    await Promise.all([
      signProposal({
        coordinator: new CoordinatorClient(url),
        sessionId,
        sessionKey,
        proposalId,
        myId: dkgA.myId,
        mySecretShare: dkgA.mySecretShare,
        gpk,
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
        gpk,
        threshold,
        maxRounds: 200,
      }),
    ]);

    let capturedInputs: Record<string, unknown> | undefined;
    const fakeProver: ProverPort = {
      async capabilities() {
        return { circuits: [CircuitId.TransferMultisig], environment: "native" as const };
      },
      async prove(circuit, inputs): Promise<ProofBundle> {
        capturedInputs = inputs;
        expect(circuit).toBe(CircuitId.TransferMultisig);
        return {
          circuitId: CircuitId.TransferMultisig,
          proof: new Uint8Array([1]),
          publicInputs: Array.from({ length: PUBLIC_INPUT_COUNT[CircuitId.TransferMultisig] }, () => new Uint8Array(32)),
        };
      },
    };

    const result = await executeProposal({
      coordinator: new CoordinatorClient(url),
      sessionId,
      sessionKey,
      proposalId,
      gpk,
      threshold,
      publicShares,
      prover: { prove: (inputs) => fakeProver.prove(CircuitId.TransferMultisig, inputs) },
      buildInputs: (signature, proposal) => buildTransferMultisigInputsFromProposal(signature, proposal, gpk),
      buildInstructions: () => [],
    });

    expect(capturedInputs).toBeDefined();
    expect(capturedInputs).toHaveProperty("old_note");
    expect(capturedInputs).toHaveProperty("memo_note");
    expect(capturedInputs).toHaveProperty("change_note");
    expect((capturedInputs as Record<string, unknown>).old_note_index).toBe("0");
    expect(result.bundle.circuitId).toBe(CircuitId.TransferMultisig);
    expect(result.bundle.publicInputs).toHaveLength(24);
  });
});
