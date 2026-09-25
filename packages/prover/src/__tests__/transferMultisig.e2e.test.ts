import { mkdtemp, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Fr } from "@kakure/sdk";
import { CircuitId } from "@kakure/sdk/tx";
import { prove } from "../prove.js";
import { buildTransferMultisigInputMap } from "../circuits/builders.js";
import type { NoteInput } from "../marshal.js";
import { A_ARTIFACTS_DIR, hasRealArtifacts } from "./fixtures.js";

/**
 * Real end-to-end proof of `kat_multisig_transfer_accepts` (values copied verbatim from
 * `multisig/transfer_multisig/src/main.nr` / `Prover.toml` -- see the workstream D report for the
 * source lines). Proves through the FULL pipeline: noir_js witness -> `sunspot prove` ->
 * self-`sunspot verify` -> I-1 layout assertions. Skipped with a clear message when workstream
 * A's `.ccs`/`.pk` build output isn't available (they are gitignored, build-worktree-only).
 */
const circuit = "transfer_multisig";
const run = hasRealArtifacts(circuit) ? it : it.skip;

const hex = (h: string) => new Fr(BigInt(h));

const OLD_NOTE: NoteInput = {
  noteVersion: new Fr(1n),
  assetId: hex("0x1234567890123456789012345678901234567890"),
  noteType: new Fr(1n),
  conditionsHash: new Fr(0n),
  value: new Fr(100n),
  owner: hex("0x0f0c6b3c0a818ce637e33dc7b49438f89a0531ef1ad200710fdb897354f7f2ea"),
  psi: hex("0x0981a88f9e119b057498a4ab99ed5379a1ea91c642454fc0c07aacc1f5cd5731"),
  parents: new Fr(0n),
};

// regenerated for kakure.* domains (circuits/scripts/gen_frost_kats.ts)
const MEMO_NOTE: NoteInput = {
  noteVersion: new Fr(1n),
  assetId: hex("0x1234567890123456789012345678901234567890"),
  noteType: new Fr(0n),
  conditionsHash: new Fr(0n),
  value: new Fr(40n),
  owner: hex("0x1113074e2fb269d979ad2b64e6fe70b1967c67b007b706600603b847306aefe3"),
  psi: hex("0x2d968b4ef3090d631f98d339ca1aad9241cd14f7a3a584983662760630b8db2e"),
  parents: hex("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000"),
};

const CHANGE_NOTE: NoteInput = {
  noteVersion: new Fr(1n),
  assetId: hex("0x1234567890123456789012345678901234567890"),
  noteType: new Fr(1n),
  conditionsHash: new Fr(0n),
  value: new Fr(60n),
  owner: hex("0x0f0c6b3c0a818ce637e33dc7b49438f89a0531ef1ad200710fdb897354f7f2ea"),
  psi: hex("0x1a72e6c3463dd2509150c482ad772ede1290d453977279eed05f10ae8cbd75f0"),
  parents: new Fr(0n),
};

const GPK: [bigint, bigint] = [
  0x2546ab52faee9ab8ead1ad868567473b9757c6456c137274b12a5c51330d764dn,
  0x0d7a564269d3675f75799ee9d7574b00d01190b243041994c0e460af507a71aan,
];
const FROST_R: [bigint, bigint] = [
  0x24e57b1f9a6718f1f762d44405f35a6b7069a324020ac2aa0640271d488fc864n,
  0x2634e350fcead5983008f940bc8956cd62adba8c81816ded57f5fba8306bfd87n,
];
const RECIPIENT_IN_PUB: [bigint, bigint] = [
  0x1b16e357953d68d73398c838aa883cc65ddae2aef75a4bc437e4232afdbe43c8n,
  0x02d7ee0be055310d2895c5ed5090a8aa1c700e73c64294f1e817ec77f46b4fdcn,
];
const COMPLIANCE_PK: [bigint, bigint] = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const KAT_FROST_Z = hex("0x04ff02bb111b27461ff96210e331fc5be63f4fd36ea24dce0a77da9c4ed923c8");

async function prepareWritableArtifacts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kakure-prover-e2e-"));
  for (const ext of ["json", "ccs", "pk", "vk"]) {
    await symlink(`${A_ARTIFACTS_DIR}/${circuit}.${ext}`, `${dir}/${circuit}.${ext}`);
  }
  return dir;
}

describe("prove() end-to-end: transfer_multisig KAT", () => {
  run(
    "produces a self-verifying ProofBundle matching I-1's 24-entry layout",
    async () => {
      // sunspot prove writes .proof/.pw next to the .ccs file -- symlink into a private, writable
      // temp dir so A's (read-only) worktree is never mutated.
      const workDir = await prepareWritableArtifacts();
      try {
        const inputMap = buildTransferMultisigInputMap({
          compliancePk: COMPLIANCE_PK,
          gpk: GPK,
          frostR: FROST_R,
          frostZ: KAT_FROST_Z,
          recipientInPub: RECIPIENT_IN_PUB,
          oldNote: OLD_NOTE,
          oldNoteIndex: 0,
          oldNotePath: Array(32).fill(new Fr(0n)),
          memoNote: MEMO_NOTE,
          memoEph: new Fr(4n),
          changeNote: CHANGE_NOTE,
          changeEph: new Fr(5n),
        });

        const started = Date.now();
        const bundle = await prove(CircuitId.TransferMultisig, inputMap, { artifactsDir: workDir });
        const elapsedMs = Date.now() - started;

        expect(bundle.circuitId).toBe(CircuitId.TransferMultisig);
        expect(bundle.publicInputs).toHaveLength(24);
        for (const word of bundle.publicInputs) expect(word.length).toBe(32);

        // I-1: publicInputs[0..1] == compliance key.
        expect(Buffer.from(bundle.publicInputs[0]).toString("hex")).toBe(
          COMPLIANCE_PK[0].toString(16).padStart(64, "0"),
        );
        expect(Buffer.from(bundle.publicInputs[1]).toString("hex")).toBe(
          COMPLIANCE_PK[1].toString(16).padStart(64, "0"),
        );

        const proofStat = await stat(`${workDir}/${circuit}.proof`);
        const pwStat = await stat(`${workDir}/${circuit}.pw`);
        // eslint-disable-next-line no-console
        console.log(
          `[transfer_multisig e2e] prove()=${elapsedMs}ms proof=${proofStat.size}B (uncompressed on disk) bundle.proof=${bundle.proof.length}B (compressed, workstream G) pw=${pwStat.size}B`,
        );
        // Workstream G: prove() compresses the proof before returning it (see prove.ts's doc
        // comment) -- `proofStat.size` is the RAW on-disk `.proof` file's size (still 388 bytes,
        // uncompressed -- sunspot itself is unchanged), while `bundle.proof` is the 192-byte
        // compressed on-chain wire format.
        expect(proofStat.size).toBe(388);
        expect(bundle.proof.length).toBe(192);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );

  if (!hasRealArtifacts(circuit)) {
    it("skips: no transfer_multisig.{json,ccs,pk,vk} found", () => {
      console.warn(
        `transferMultisig.e2e.test.ts: skipping -- no ${circuit} build artifacts under ${A_ARTIFACTS_DIR}. ` +
          "Run \`just build-circuits\` (workstream A) or set KAKURE_TEST_ARTIFACTS_DIR.",
      );
    });
  }
});
