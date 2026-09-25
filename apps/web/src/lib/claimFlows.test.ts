// @vitest-environment node
/**
 * The claim page's withdraw witness against the REAL `withdraw` circuit (committed ACIR executed
 * with noir_js -- no Sunspot, no validator): a recipient account is paid an incoming note exactly
 * as `assembleTransferMultisig`'s memo path mints one, the full-account `ScanEngine` finds it
 * (spend scalar included), and `assembleWithdrawInputs` produces an `InputMap` the circuit
 * accepts -- the same shape `e2e/scenario.test.ts` step 6 proves and submits.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  Fr,
  InMemoryEphemeralCounterStore,
  KeyRepository,
  LeanIMT,
  PARENTS_HIDDEN,
  ScanEngine,
  SolanaAccount,
  UtxoRepository,
  demEncrypt,
  mintIncomingNote,
  type IndexerNoteInserted,
} from "@kakure/sdk";
import { LocalTreeWitnessSource } from "@kakure/sdk/tx";
import { recipientField } from "@kakure/sdk/solana";
import type { Point } from "@kakure/sdk/tss";
import { executeWitness } from "@kakure/prover";
import { assembleWithdrawInputs } from "./claimFlows.js";

type CompiledCircuit = Parameters<typeof executeWitness>[1];
type InputMap = Parameters<typeof executeWitness>[2];

const nodeRequire = createRequire(import.meta.url);
const { existsSync } = nodeRequire("node:fs") as typeof import("node:fs");
const { join } = nodeRequire("node:path") as typeof import("node:path");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const ACIR_PATH = process.env.KAKURE_WITHDRAW_ACIR ?? join(REPO_ROOT, "circuits", "target", "withdraw.json");
const hasAcir = existsSync(ACIR_PATH);

const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const ASSET_ID = new Fr(0x1234567890123456789012345678901234567890n);
const PAID = 400_000n;

function hex(f: Fr): string {
  return f.toString();
}

describe("claim page withdraw witness (real withdraw circuit)", () => {
  it.skipIf(!hasAcir)(
    "the full-account scan finds the paid note and assembleWithdrawInputs executes in-circuit",
    async () => {
      const circuit = nodeRequire(ACIR_PATH) as CompiledCircuit;
      const recipient = await SolanaAccount.fromAccountSignature(randomBytes(64));
      const addr = await recipient.canonicalIncomingAddress(0n);

      // Pay the recipient one incoming note (the memo `assembleTransferMultisig` mints), and put
      // it in a pool tree behind an unrelated leaf so the path is non-trivial.
      const memo = await mintIncomingNote(new Fr(4n), PAID, addr.pub, new Fr(0n), ASSET_ID, COMPLIANCE_PK, PARENTS_HIDDEN);
      const tree = new LeanIMT(32);
      await tree.insert(new Fr(0xabcdefn));
      await tree.insert(memo.commitment);

      // What the pool's NoteInserted event carries (plaintext order = NoteProcessor.recover's 7
      // fields; psi is never encrypted, it is re-derived from the cek).
      const n = memo.note;
      const ciphertext = await demEncrypt(memo.cek, [n.noteVersion, n.assetId, n.noteType, n.conditionsHash, n.value, n.owner, n.parents]);
      const event: IndexerNoteInserted = {
        leaf_index: 1,
        leaf: hex(memo.commitment),
        eph_pub_x: hex(new Fr(memo.ephPub[0])),
        tag: hex(memo.tag),
        cek_wrap: hex(memo.cekWrap!),
        ciphertext: ciphertext.map(hex),
        root: hex(tree.getRoot()),
      };
      const utxos = new UtxoRepository();
      const keyRepo = new KeyRepository(recipient, new InMemoryEphemeralCounterStore());
      const engine = new ScanEngine({ fetchNotes: async () => [event] }, keyRepo, utxos, COMPLIANCE_PK);
      await engine.sync(0);
      const notes = utxos.getUnspentNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note.value).toBe(PAID);

      const destination = Keypair.generate().publicKey;
      const { inputs, amount } = await assembleWithdrawInputs({
        merkle: new LocalTreeWitnessSource(tree),
        account: recipient,
        keyRepo,
        note: notes[0]!,
        compliancePk: COMPLIANCE_PK,
        recipientField32: recipientField(destination),
      });
      expect(amount).toBe(PAID);
      await executeWitness("withdraw", circuit, inputs as InputMap);
    },
    300_000,
  );
});
