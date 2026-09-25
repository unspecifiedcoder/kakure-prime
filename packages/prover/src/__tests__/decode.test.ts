import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodePublicWitness, decodeProof, encodePublicWitness, proofBytesForChain } from "../decode.js";
import { A_ARTIFACTS_DIR, hasPrebuiltProof } from "./fixtures.js";

const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("decodePublicWitness / decodeProof against the real transfer_multisig fixtures", () => {
  const circuit = "transfer_multisig";
  const run = hasPrebuiltProof(circuit) ? it : it.skip;

  run("parses the 780-byte .pw into 24 canonical 32-byte fields in I-1 order", async () => {
    const pw = new Uint8Array(await readFile(`${A_ARTIFACTS_DIR}/${circuit}.pw`));
    expect(pw.length).toBe(780);
    const entries = decodePublicWitness(pw);
    expect(entries).toHaveLength(24);
    for (const e of entries) expect(e.length).toBe(32);

    // I-1 CircuitId.TransferMultisig layout: [cpk_x, cpk_y, nullifier, root, memo_leaf, ...]
    // FIXTURE_COMPLIANCE_X/Y from circuits/shared/src/common/test_fixtures.nr.
    expect(bytesToHex(entries[0])).toBe(
      "085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111",
    );
    expect(bytesToHex(entries[1])).toBe(
      "245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8",
    );
    // entries[3] is the Merkle root the circuit computed against the KAT's old_note_path.
    expect(entries[3].length).toBe(32);
  });

  run("parses the 388-byte .proof (commitment_count = 1)", async () => {
    const proof = new Uint8Array(await readFile(`${A_ARTIFACTS_DIR}/${circuit}.proof`));
    expect(proof.length).toBe(388);
    const decoded = decodeProof(proof);
    expect(decoded.a.length).toBe(64);
    expect(decoded.b.length).toBe(128);
    expect(decoded.c.length).toBe(64);
    expect(decoded.commitmentCount).toBe(1);
    expect(decoded.commitments.length).toBe(64);
    expect(decoded.commitmentPok.length).toBe(64);
  });

  run("encodePublicWitness round-trips decodePublicWitness byte-for-byte", async () => {
    const pw = new Uint8Array(await readFile(`${A_ARTIFACTS_DIR}/${circuit}.pw`));
    const entries = decodePublicWitness(pw);
    expect(bytesToHex(encodePublicWitness(entries))).toBe(bytesToHex(pw));
  });

  run("proofBytesForChain concatenates proof ‖ full .pw (header included)", async () => {
    const proof = new Uint8Array(await readFile(`${A_ARTIFACTS_DIR}/${circuit}.proof`));
    const pw = new Uint8Array(await readFile(`${A_ARTIFACTS_DIR}/${circuit}.pw`));
    const publicInputs = decodePublicWitness(pw);
    const chainBytes = proofBytesForChain({ proof, publicInputs });
    expect(chainBytes.length).toBe(proof.length + pw.length);
    expect(bytesToHex(chainBytes.slice(0, proof.length))).toBe(bytesToHex(proof));
    expect(bytesToHex(chainBytes.slice(proof.length))).toBe(bytesToHex(pw));
  });

  if (!hasPrebuiltProof(circuit)) {
    it("skips: no pre-built transfer_multisig.proof/.pw found", () => {
      console.warn(
        `decode.test.ts: skipping -- no ${circuit}.proof/.pw under ${A_ARTIFACTS_DIR}. ` +
          "Set KAKURE_TEST_ARTIFACTS_DIR or run \`just verify-kat\` in workstream A's worktree.",
      );
    });
  }
});
