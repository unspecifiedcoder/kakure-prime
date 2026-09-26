import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPaths } from "../artifacts.js";
import { verifyWithSunspot } from "../sunspot.js";

// Every public input of every circuit that has a committed .proof/.pw fixture must be bound by
// the proof: flipping one bit of any entry must make `sunspot verify` fail. Guards against
// unconstrained `pub` parameters (slice-2 F-1: withdraw's `_recipient`/`_intent_hash`, which
// Groth16 leaves with K[i] = the point at infinity when a public wire has no occurrences in the
// R1CS -- the proof then verifies for *any* value of that input).
const CIRCUITS = ["withdraw", "deposit", "transfer_multisig"];

describe("every public input is bound by the proof", () => {
  for (const name of CIRCUITS) {
    const p = artifactPaths(name);
    const pwPath = p.ccs.replace(/\.ccs$/, ".pw");
    const proofPath = p.ccs.replace(/\.ccs$/, ".proof");
    if (!existsSync(pwPath) || !existsSync(proofPath)) {
      it.skip(`${name}: fixtures unavailable`, () => {});
      continue;
    }
    const pw = readFileSync(pwPath);
    const n = pw.readUInt32BE(0);

    it(`${name}: baseline verifies`, async () => {
      expect(await verifyWithSunspot(name, p.vk, proofPath, pwPath)).toBe(true);
    });

    for (let i = 0; i < n; i++) {
      it(`${name}: mutated public input ${i} fails verification`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pw-mut-"));
        const mut = Buffer.from(pw);
        mut[12 + i * 32 + 31] ^= 0x01;
        const mutPath = join(dir, `${name}.pw`);
        writeFileSync(mutPath, mut);
        await expect(verifyWithSunspot(name, p.vk, proofPath, mutPath)).rejects.toThrow(/sunspot verify exited/);
      });
    }
  }
});
