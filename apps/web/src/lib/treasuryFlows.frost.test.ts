// @vitest-environment node
/**
 * The FROST-message contract behind "Pay people", checked against the REAL `transfer_multisig`
 * circuit (the committed ACIR, executed with noir_js -- no Sunspot, no validator):
 *
 *   1. what the app posts to the coordinator (`proposal.messageHex`) is exactly
 *      `assembleTransferMultisig(...).message` -- the `m` every signer's share covers;
 *   2. row 1 (a scanner-produced source note) executes in-circuit;
 *   3. the pre-fix row-2 input -- a hand-built `{...sourceNote, value: value - amount}` "change
 *      note" carrying row 1's leaf index / nullifier / psi -- is rejected by the circuit with
 *      "FROST signature invalid" (the payroll e2e's failure), because the circuit re-derives the
 *      root from the note fields + path it is handed, while the app signed the indexer's real root;
 *   4. the real change note (`resolveChangeNote` from the indexer's NoteInserted events) executes.
 *
 * Runs a real 2-of-2 DKG over the in-memory coordinator and the real `signProposal` /
 * `executeProposal` state machine -- the same code path `payOneRecipient` uses.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { Fr, InMemoryEphemeralCounterStore, LeanIMT, computePsi, computeNullifier, deriveCek, isEvenY, leaf } from "@kakure/sdk";
import { LocalTreeWitnessSource } from "@kakure/sdk/tx";
import { multisigOwner, deriveGroupViewKeyFromSecret, type MultisigNoteView } from "@kakure/sdk/frost";
import { combineGroupViewContributions, scalarBaseMul, type Point } from "@kakure/sdk/tss";
import { CoordinatorClient, fetchProposal, runDkgCeremony, deriveSessionKeyFromGvsDecimal } from "@kakure/cli";
import { FakeCoordinator } from "@kakure/cli/testing";
import { executeWitness } from "@kakure/prover";

type CompiledCircuit = Parameters<typeof executeWitness>[1];
type InputMap = Parameters<typeof executeWitness>[2];
import type { GroupRecord } from "./treasury.js";
import type { ReceiveAddress } from "./receiveAddress.js";
import { assembleRow, changeNoteView, resolveChangeNote, runTransferMultisigProposal } from "./treasuryFlows.js";

// This app's vite config shims `fs`/`path` to browser no-ops (see vite.config.ts), so the ACIR is
// read through a real Node `require`, which those aliases never touch.
const nodeRequire = createRequire(import.meta.url);
const { existsSync } = nodeRequire("node:fs") as typeof import("node:fs");
const { join } = nodeRequire("node:path") as typeof import("node:path");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const ACIR_PATH = process.env.KAKURE_TRANSFER_MULTISIG_ACIR ?? join(REPO_ROOT, "circuits", "target", "transfer_multisig.json");
const hasAcir = existsSync(ACIR_PATH);

const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const ASSET_ID = new Fr(0x1234567890123456789012345678901234567890n);
const DEPOSIT = 1_000_000n;
const AMOUNTS = [400_000n, 300_000n];

/** `payOneRecipient`'s pre-fix `changeNote` -- kept here verbatim as the regression fixture. */
function legacySyntheticChangeNote(sourceNote: MultisigNoteView, amount: bigint): MultisigNoteView {
  return {
    ...sourceNote,
    leafIndex: sourceNote.leafIndex,
    note: { ...sourceNote.note, value: sourceNote.note.value - amount },
  };
}

describe("Pay people: FROST message vs the real transfer_multisig circuit", () => {
  let fake: FakeCoordinator;
  let url: string;
  let group: GroupRecord;
  let gpk: Point;
  let quorum: { myId: bigint; secretShare: bigint }[];
  let tree: LeanIMT;
  let sourceNote: MultisigNoteView;
  let recipient: ReceiveAddress;
  let circuit: CompiledCircuit;

  const witnessProver = {
    async prove(inputs: Record<string, unknown>): Promise<{ inputs: Record<string, unknown> }> {
      await executeWitness("transfer_multisig", circuit, inputs as InputMap);
      return { inputs };
    },
  };

  beforeAll(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
    if (hasAcir) circuit = nodeRequire(ACIR_PATH) as CompiledCircuit;

    // Real 2-of-2 DKG over the in-memory coordinator (2, not 5: FROST is threshold-agnostic and a
    // 5-party ceremony is minutes of Poseidon/BJJ work).
    const sessionId = randomBytes(32).toString("hex");
    const seeds = [randomBytes(32), randomBytes(32)];
    const results = await Promise.all(
      seeds.map((seed) =>
        runDkgCeremony({
          coordinator: new CoordinatorClient(url),
          sessionId,
          threshold: 2,
          memberCount: 2,
          ed25519Seed: new Uint8Array(seed),
          ed25519PublicKey: ed25519.getPublicKey(seed),
          context: 0x4b616b757265n,
          maxRounds: 200,
        }),
      ),
    );
    const me = results[0]!;
    gpk = [...me.gpk];
    const gvs = await combineGroupViewContributions(
      [...me.viewContributions].map(([id, r]) => ({ index: Number(id), r })),
      gpk,
    );
    const groupView = await deriveGroupViewKeyFromSecret(gvs, gpk);
    group = {
      sessionId,
      name: "test",
      threshold: 2,
      memberCount: 2,
      myId: me.myId.toString(),
      participantIds: me.participantIds.map((id) => id.toString()),
      gpk: { x: gpk[0].toString(16), y: gpk[1].toString(16) },
      mySecretShare: me.mySecretShare.toString(),
      groupViewKey: {
        gvs: gvs.toString(),
        v: groupView.v.toString(),
        V: { x: groupView.V[0].toString(16), y: groupView.V[1].toString(16) },
        roll: groupView.roll.toString(),
      },
      dealerCommitments: Object.fromEntries(
        [...me.dealerCommitments].map(([id, c]) => [id.toString(), c.map((p) => ({ x: p[0].toString(16), y: p[1].toString(16) }))]),
      ),
      ceremonyKeypairSecretB64: "",
    };
    quorum = results.map((r) => ({ myId: r.myId, secretShare: r.mySecretShare }));

    // The pool's tree with one multisig-owned deposit at leaf 0, exactly as the scanner would
    // report it (fields that hash to the leaf; nullifier = H(psi, leafIndex)).
    tree = new LeanIMT(32);
    const depositEph = new Fr(1234n);
    const psi = await computePsi(deriveCek(depositEph, COMPLIANCE_PK));
    const note = {
      noteVersion: new Fr(1n),
      assetId: ASSET_ID,
      noteType: new Fr(1n),
      conditionsHash: new Fr(0n),
      value: DEPOSIT,
      owner: new Fr(await multisigOwner(gpk)),
      psi,
      parents: new Fr(0n),
    };
    const commitment = await leaf(note);
    await tree.insert(commitment);
    sourceNote = { note, commitment, leafIndex: 0, nullifier: await computeNullifier(psi, new Fr(0n)), isIncoming: false };

    // A recipient incoming address is its own discovery tag, so its pub must be even-y (the same
    // invariant `canonicalIncomingAddress` upholds for a real recipient).
    let k = 7n;
    let rp = scalarBaseMul(k);
    while (!isEvenY(rp)) rp = scalarBaseMul(++k);
    recipient = { pubX: rp[0], pubY: rp[1] } as ReceiveAddress;
  }, 120_000);

  afterAll(async () => {
    await fake.stop();
  });

  const counters = new InMemoryEphemeralCounterStore();

  it("posts exactly assembleTransferMultisig(...).message as the proposal's FROST message", async () => {
    const assembled = await assembleRow({
      merkle: new LocalTreeWitnessSource(tree),
      counters: new InMemoryEphemeralCounterStore(),
      gpk,
      group,
      compliancePk: COMPLIANCE_PK,
      sourceNote,
      recipient,
      amount: AMOUNTS[0]!,
      memoEph: new Fr(4n),
    });
    const sessionId = randomBytes(32).toString("hex");
    await runTransferMultisigProposal({
      coordinatorUrl: url,
      sessionId,
      proposalId: "msg-check",
      gpk,
      group,
      quorum,
      assembled,
      prover: { prove: async (inputs) => inputs },
      buildInstructions: () => [],
      maxRounds: 200,
    });
    const proposal = await fetchProposal(new CoordinatorClient(url), sessionId, deriveSessionKeyFromGvsDecimal(group.groupViewKey.gvs, sessionId), "msg-check");
    expect(BigInt(proposal.messageHex)).toBe(assembled.message);
  });

  it.skipIf(!hasAcir)(
    "row 1, row 2 with the legacy synthetic change note (rejected: FROST signature invalid), row 2 with the real change note",
    async () => {
      const merkle = new LocalTreeWitnessSource(tree);

      // Row 1: the scanner's deposit view -- executes in-circuit.
      const row1 = await assembleRow({ merkle, counters, gpk, group, compliancePk: COMPLIANCE_PK, sourceNote, recipient, amount: AMOUNTS[0]!, memoEph: new Fr(4n) });
      await runTransferMultisigProposal({
        coordinatorUrl: url, sessionId: randomBytes(32).toString("hex"), proposalId: "row-1",
        gpk, group, quorum, assembled: row1, prover: witnessProver, buildInstructions: () => [], maxRounds: 200,
      });

      // The pool appends the memo leaf then the change leaf (the circuit's public-output order).
      await tree.insert(row1.memo.commitment);
      await tree.insert(row1.changeCommitment);

      // Row 2 as the pre-fix code built it: the SAME `m` shape, signed by a real quorum, but the
      // note fields the circuit is handed don't hash to any leaf under the path/root that was
      // signed -> the circuit's recomputed `m` differs -> "FROST signature invalid".
      const legacy = legacySyntheticChangeNote(sourceNote, AMOUNTS[0]!);
      const row2Legacy = await assembleRow({ merkle, counters, gpk, group, compliancePk: COMPLIANCE_PK, sourceNote: legacy, recipient, amount: AMOUNTS[1]! });
      await expect(
        runTransferMultisigProposal({
          coordinatorUrl: url, sessionId: randomBytes(32).toString("hex"), proposalId: "row-2-legacy",
          gpk, group, quorum, assembled: row2Legacy, prover: witnessProver, buildInstructions: () => [], maxRounds: 200,
        }),
      ).rejects.toThrow(/FROST signature invalid/);

      // Row 2 fixed: the change note resolved from the indexer's NoteInserted events.
      const events = tree.levels[0]!.map((l, i) => ({
        leaf_index: i, leaf: l.toString(), eph_pub_x: "0x0", ciphertext: [], root: tree.getRoot().toString(),
      }));
      const real = await resolveChangeNote({ fetchNotes: async (from) => events.filter((e) => e.leaf_index >= from) }, row1, {
        fromLeafIndex: 1, timeoutMs: 1000,
      });
      expect(real.leafIndex).toBe(2);
      expect(real.commitment.equals(row1.changeCommitment)).toBe(true);
      expect(real).toEqual(await changeNoteView(row1, 2));
      // ...and its fields hash to the leaf the pool holds.
      expect((await leaf(real.note)).equals(tree.levels[0]![2]!)).toBe(true);

      const row2 = await assembleRow({ merkle, counters, gpk, group, compliancePk: COMPLIANCE_PK, sourceNote: real, recipient, amount: AMOUNTS[1]! });
      await runTransferMultisigProposal({
        coordinatorUrl: url, sessionId: randomBytes(32).toString("hex"), proposalId: "row-2",
        gpk, group, quorum, assembled: row2, prover: witnessProver, buildInstructions: () => [], maxRounds: 200,
      });
    },
    600_000,
  );
});
