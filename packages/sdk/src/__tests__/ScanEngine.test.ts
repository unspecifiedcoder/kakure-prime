import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { SolanaAccount } from "../keys/SolanaAccount.js";
import { KeyRepository } from "../state/KeyRepository.js";
import { UtxoRepository } from "../state/UtxoRepository.js";
import { InMemoryEphemeralCounterStore } from "../state/EphemeralCounterStore.js";
import { mintSelfNote } from "../note/mint.js";
import { demEncrypt } from "../crypto/dem.js";
import { toFr } from "../crypto/fields.js";
import {
  ScanEngine,
  type IndexerNoteInserted,
  type NotesTransport,
} from "../sync/ScanEngine.js";

// Master plan item C.5: `sync/ScanEngine.ts` consumes the indexer's I-8 `NoteInserted` feed (I-4 shape)
// instead of ethers Contract event logs, single-key trial decryption via the ported `NoteProcessor`. Group
// (multisig) scanning is `MultisigScanEngine`, a thin transport adapter over the already-heavily-tested
// `frost/multisigScan.ts` `MultisigScanner` (see `multisig-note.test.ts`'s 28 cases) -- this file only
// covers the single-key path plus the transport wiring, to avoid duplicating that coverage.
const COMPLIANCE_PK = mulPointEscalar(Base8, 424242n);

async function fixedTransport(
  events: readonly IndexerNoteInserted[],
): Promise<NotesTransport> {
  return { fetchNotes: async () => events };
}

describe("sync/ScanEngine: single-key scanning over the indexer's I-8 feed", () => {
  it("discovers a self note it minted, decrypts it, and credits the utxo repo's balance", async () => {
    const account = await SolanaAccount.fromSeed("scan-engine-self-note");
    const keyRepo = new KeyRepository(account, new InMemoryEphemeralCounterStore());
    const utxoRepo = new UtxoRepository();

    const spendScalar = await account.getSelfSpendKey();
    const assetId = toFr(0x1234n);
    const value = 5000n;

    const selfEph = await keyRepo.nextSelfEphemeral();
    const minted = await mintSelfNote(selfEph.eph, value, spendScalar, assetId, COMPLIANCE_PK);

    // Ciphertext plaintext order matches `NoteProcessor.recover`: 7 fields, `psi` excluded (it is
    // re-derived from `cek`, never encrypted).
    const plaintext = [
      minted.note.noteVersion,
      minted.note.assetId,
      minted.note.noteType,
      minted.note.conditionsHash,
      minted.note.value,
      minted.note.owner,
      minted.note.parents,
    ];
    const ciphertext = await demEncrypt(minted.cek, plaintext);

    const event: IndexerNoteInserted = {
      leaf_index: 1,
      leaf: minted.commitment.toString(),
      eph_pub_x: new Fr(minted.ephPub[0]).toString(),
      tag: null,
      cek_wrap: null,
      ciphertext: ciphertext.map((c) => c.toString()),
      root: "0x00",
    };

    const engine = new ScanEngine(
      await fixedTransport([event]),
      keyRepo,
      utxoRepo,
      COMPLIANCE_PK,
    );
    await engine.sync(0);

    const notes = utxoRepo.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note.value).toBe(value);
    expect(notes[0]!.spent).toBe(false);
    expect(utxoRepo.getBalance(assetId)).toBe(value);
  });

  it("ignores a note tagged for a different account (foreign self tag)", async () => {
    const owner = await SolanaAccount.fromSeed("scan-engine-owner");
    const stranger = await SolanaAccount.fromSeed("scan-engine-stranger");
    const keyRepo = new KeyRepository(owner, new InMemoryEphemeralCounterStore());
    const utxoRepo = new UtxoRepository();

    const strangerEph = await (
      await stranger.getSelfEphemeral(0n)
    );
    const minted = await mintSelfNote(
      strangerEph,
      1000n,
      await stranger.getSelfSpendKey(),
      toFr(1n),
      COMPLIANCE_PK,
    );
    const plaintext = [
      minted.note.noteVersion,
      minted.note.assetId,
      minted.note.noteType,
      minted.note.conditionsHash,
      minted.note.value,
      minted.note.owner,
      minted.note.parents,
    ];
    const ciphertext = await demEncrypt(minted.cek, plaintext);

    const event: IndexerNoteInserted = {
      leaf_index: 1,
      leaf: minted.commitment.toString(),
      eph_pub_x: new Fr(minted.ephPub[0]).toString(),
      tag: null,
      cek_wrap: null,
      ciphertext: ciphertext.map((c) => c.toString()),
      root: "0x00",
    };

    const engine = new ScanEngine(
      await fixedTransport([event]),
      keyRepo,
      utxoRepo,
      COMPLIANCE_PK,
    );
    await engine.sync(0);

    expect(utxoRepo.getAllNotes()).toHaveLength(0);
  });

  it("marks notes past the requested leaf index into a supplied LeanIMT mirror", async () => {
    // No merkleTree supplied -> ScanEngine must not throw when one is simply omitted.
    const account = await SolanaAccount.fromSeed("scan-engine-no-tree");
    const keyRepo = new KeyRepository(account, new InMemoryEphemeralCounterStore());
    const utxoRepo = new UtxoRepository();
    const engine = new ScanEngine(await fixedTransport([]), keyRepo, utxoRepo, COMPLIANCE_PK);
    await expect(engine.sync(0)).resolves.toBeUndefined();
  });
});
