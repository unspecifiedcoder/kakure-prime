import { randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Fr, InMemoryEphemeralCounterStore, deriveCek, computePsi, leaf } from "@kakure/sdk";
import { multisigOwner, deriveGroupViewKeyFromSecret, type MultisigNoteView } from "@kakure/sdk/frost";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import type { MerkleWitnessSource } from "@kakure/sdk/solana";
import { computeNullifier } from "@kakure/sdk";
import { CircuitId, type ProofBundle } from "@kakure/sdk/tx";
import { nativeProverPort } from "@kakure/prover";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { runDkgCeremony } from "../../dkg/ceremony.js";
import { aggregatePublicShareAt } from "../../dkg/publicShare.js";
import { scalarBaseMul, type Point } from "@kakure/sdk/tss";
import { signProposal } from "../proposal.js";
import { executeProposal } from "../execute.js";
import { assembleTransferMultisig } from "../assembleTransferMultisig.js";
import {
  buildTransferMultisigInputsFromProposal,
  createTransferMultisigProposal,
} from "../transferMultisigProposal.js";
import { deriveSessionKeyFromGvsDecimal } from "../../crypto/sessionSeal.js";

/**
 * Opt-in (env-gated) end-to-end run of the SAME flow as `transferMultisigFlow.test.ts`, but
 * against the REAL `@kakure/prover` (noir_js witness -> sunspot prove -> sunspot verify) instead
 * of a fake. Off by default: proving is a multi-minute, CPU-heavy subprocess (see
 * `@kakure/prover`'s own e2e test), which is why the fast fake-prover version above is the one
 * that runs on every `pnpm test`. Run with:
 *
 *   KAKURE_CLI_REAL_PROVER_TEST=1 pnpm --filter @kakure/cli test -- transferMultisigFlow.real
 */
const A_ARTIFACTS_DIR =
  process.env.KAKURE_TEST_ARTIFACTS_DIR ?? "/mnt/e/github2/kakure-wt/a-circuits/circuits/target";
const CIRCUIT = "transfer_multisig";

function hasRealArtifacts(): boolean {
  return ["json", "ccs", "pk", "vk"].every((ext) => existsSync(`${A_ARTIFACTS_DIR}/${CIRCUIT}.${ext}`));
}

const enabled = process.env.KAKURE_CLI_REAL_PROVER_TEST === "1" && hasRealArtifacts();
const run = enabled ? it : it.skip;

const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];

function zeroPathWitnessSource(): MerkleWitnessSource {
  return {
    async witnessFor(leaf: Fr) {
      return { leafIndex: 0, siblings: Array.from({ length: 32 }, () => new Fr(0n)), root: leaf };
    },
  };
}

describe("real transfer_multisig flow through the REAL @kakure/prover (opt-in)", () => {
  let fake: FakeCoordinator;
  let url: string;
  let workDir: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
    if (enabled) {
      workDir = await mkdtemp(join(tmpdir(), "kakure-cli-real-prover-"));
      for (const ext of ["json", "ccs", "pk", "vk"]) {
        await symlink(`${A_ARTIFACTS_DIR}/${CIRCUIT}.${ext}`, `${workDir}/${CIRCUIT}.${ext}`);
      }
    }
  });
  afterEach(async () => {
    await fake.stop();
    if (enabled) await rm(workDir, { recursive: true, force: true });
  });

  run(
    "produces a proof the real sunspot verify accepts",
    async () => {
      const sessionId = Buffer.from(randomBytes(32)).toString("hex");
      const threshold = 2;
      const memberCount = 2;
      const context = 0x7777n;

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

      const proposalId = "real-transfer-multisig-1";
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

      const prover = nativeProverPort({ artifactsDir: workDir });
      const result = await executeProposal<ProofBundle>({
        coordinator: new CoordinatorClient(url),
        sessionId,
        sessionKey,
        proposalId,
        gpk,
        threshold,
        publicShares,
        prover: { prove: (inputs) => prover.prove(CircuitId.TransferMultisig, inputs) },
        buildInputs: (signature, proposal) => buildTransferMultisigInputsFromProposal(signature, proposal, gpk),
        buildInstructions: () => [],
      });

      expect(result.bundle.circuitId).toBe(CircuitId.TransferMultisig);
      expect(result.bundle.publicInputs).toHaveLength(24);
      expect(result.bundle.proof.length).toBeGreaterThan(0);
    },
    600_000,
  );

  if (!enabled) {
    it("skipped: set KAKURE_CLI_REAL_PROVER_TEST=1 (and have transfer_multisig build artifacts) to run", () => {
      console.warn(
        `transferMultisigFlow.real.test.ts: skipped -- set KAKURE_CLI_REAL_PROVER_TEST=1 and ensure ` +
          `${CIRCUIT}.{json,ccs,pk,vk} exist under ${A_ARTIFACTS_DIR}`,
      );
    });
  }
});
