import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Fr } from "@aztec/foundation/fields";
import {
  ComputeBudgetProgram,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  bjjCiphersuite as cs,
  encodeMessage,
  commit,
  groupCommitment,
  bindingFactors,
  signShare,
  aggregate,
  verify,
  multisigOwner,
  multisigDepositEph,
  deriveGroupViewKeyFromSecret,
  type MultisigNoteView,
} from "@kakure/sdk/frost";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import {
  MultisigScanEngine,
  ScanEngine,
  httpNotesTransport,
  SolanaAccount,
  KeyRepository,
  UtxoRepository,
  InMemoryEphemeralCounterStore,
  computePsi,
  deriveCek,
  leaf,
  publicKey,
  isEvenY,
  packParents,
} from "@kakure/sdk";
import {
  TxBuilder,
  poolPda,
  assetPda,
  nullifierPda,
  programDataAddress,
  assetId,
  recipientField,
  genesisLeaf,
  indexerTransport,
  decodePool,
  decodePoolError,
  CircuitId,
  createSharedLookupTable,
  extendSharedLookupTable,
  sendV0,
  type SharedLookupTable,
  type ProofBundle,
  type PoolAccount,
} from "@kakure/sdk/solana";
import { IndexerWitnessSource } from "@kakure/sdk/tx";
import { nativeProverPort } from "@kakure/prover";
import {
  CoordinatorClient,
  runDkgCeremony,
  aggregatePublicShareAt,
  assembleTransferMultisig,
  createTransferMultisigProposal,
  buildTransferMultisigInputsFromProposal,
  signProposal,
  executeProposal,
  deriveSessionKeyFromGvsDecimal,
  type DkgCeremonyResult,
} from "@kakure/cli";
import { startLocalnet, REPO_ROOT, type Localnet } from "./localnet.js";
import { join } from "node:path";

// FIXTURE_COMPLIANCE_{X,Y} from circuits/shared/src/common/test_fixtures.nr -- every circuit's
// mint::assert_valid_compliance_pk binds proofs to this exact key, so the pool MUST be initialized
// with it (not an arbitrary key) for any real proof to verify against the pool's on-chain state.
const FIXTURE_COMPLIANCE_X =
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n;
const FIXTURE_COMPLIANCE_Y =
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n;
const COMPLIANCE_PK: [bigint, bigint] = [FIXTURE_COMPLIANCE_X, FIXTURE_COMPLIANCE_Y];

const VERIFIER_ORDER = [
  "deposit",
  "transfer",
  "withdraw",
  "transfer_multisig",
  "split_multisig",
  "join_multisig",
  "withdraw_multisig",
] as const;

const DKG_CONTEXT = 0x4b616b757265n; // "Kakure" in hex
const DEPOSIT_AMOUNT = 1_000_000n;
const TRANSFER_AMOUNT = 400_000n;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function frToBytes32(f: Fr): Uint8Array {
  return new Uint8Array(f.toBuffer());
}

/** A memo/transfer ephemeral's own public key must be even-y (`mint::mint_incoming_note`'s
 *  "incoming eph tag must be even-y" assertion, since the eph_pub.x IS the discovery tag and a tag
 *  is only injective when y is even) -- unlike a self-family ephemeral, a memo eph is legitimately
 *  random (see note/mint.ts's `mintIncomingNote` doc comment), so there is no derivation index to
 *  roll; just resample until the public key lands even-y. */
function randomEvenYScalar(): Fr {
  for (;;) {
    const candidate = new Fr(bytesToBigIntBE(randomBytes(31)));
    if (isEvenY(publicKey(candidate))) return candidate;
  }
}

/**
 * The indexer's `/path/:leaf_index` and `/root` are two separate HTTP round trips
 * (`indexerTransport`, `@kakure/sdk/solana`) against a live, concurrently-ingesting store; a leaf
 * inserted between them makes `IndexerWitnessSource`'s own root self-check
 * (`WitnessSourceError` reason `ROOT_MISMATCH`) fail transiently even though both endpoints are
 * individually correct. Retrying the whole (idempotent, side-effect-free) operation is the
 * standard way to read consistently from an eventually-settling store without a combined
 * path+root endpoint; a real fix would add one, flagged in the workstream report.
 */
async function retryOnTransientWitnessMismatch<T>(fn: () => Promise<T>, attempts = 10): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = i === attempts - 1;
      const isRootMismatch = err instanceof Error && /ROOT_MISMATCH|does not reproduce/.test(err.message);
      if (isLast || !isRootMismatch) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("unreachable");
}

/**
 * Solana's hard packet limit for a serialized (signed) transaction. Workstream G's whole point is
 * making every real-proof `kakure_pool` instruction fit under it WITHOUT relying on the shared ALT
 * to save the day (the ALT stays, for real margin against future growth -- see `alt.ts`'s header
 * comment -- but a workstream-G-era ix should clear 1232 bytes on its own compiled-message size,
 * with the ALT only shrinking it further). Builds the exact signed v0 transaction `sendV0` would
 * send, measures its wire size, logs it, and asserts it is within the limit -- BEFORE actually
 * sending, so a failure here reports "too big" rather than a confusing on-chain send error.
 */
const SOLANA_PACKET_LIMIT_BYTES = 1232;

async function assertFitsPacketLimit(
  connection: Connection,
  label: string,
  instructions: readonly TransactionInstruction[],
  alt: SharedLookupTable,
  feePayer: Keypair,
  extraSigners: readonly Keypair[] = [],
): Promise<void> {
  const altAccount = await alt.account(connection);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message([altAccount]);
  const vtx = new VersionedTransaction(message);
  vtx.sign([feePayer, ...extraSigners]);
  const size = vtx.serialize().length;
  // eslint-disable-next-line no-console
  console.log(`[tx-size] ${label}: ${size} bytes (limit ${SOLANA_PACKET_LIMIT_BYTES})`);
  expect(size).toBeLessThanOrEqual(SOLANA_PACKET_LIMIT_BYTES);
}

/** Fetches and decodes the pool account fresh -- every spend builder needs the CURRENT root ring
 *  (`TxBuilder`'s `resolveRootIndex`/`rootIndexFor`, workstream G) to resolve a `root_index`, and
 *  the pool's state changes with every prior step in this scenario. */
async function currentPool(connection: Connection, poolAddress: PublicKey): Promise<PoolAccount> {
  const acct = await connection.getAccountInfo(poolAddress, "confirmed");
  if (!acct) throw new Error(`currentPool: pool account ${poolAddress.toBase58()} not found`);
  return decodePool(acct.data);
}

interface DkgMember {
  keypair: Keypair;
  result: DkgCeremonyResult;
}

interface SharedState {
  net: Localnet;
  proverArtifactsDir: string;
  poolAddress: PublicKey;
  vault: PublicKey;
  assetAddr: PublicKey;
  assetIdBytes: Uint8Array;
  alt: SharedLookupTable;
  members: DkgMember[];
  gpk: [bigint, bigint];
  v: Fr;
  /** slice-2 F-2: the group's canonical view secret (decimal string), stored so any later step
   *  can derive that PROPOSAL's own session-sealing key via
   *  `deriveSessionKeyFromGvsDecimal(gvsDecimal, thatProposalsSessionId)`. */
  gvsDecimal: string;
  publicShares: Map<string, [bigint, bigint]>;
  depositedNote?: MultisigNoteView;
  transferBundle?: ProofBundle;
  recipient?: SolanaAccount;
  recipientKeypair?: Keypair;
}

describe("§7 scenario: DKG -> deposit -> 3-of-5 transfer -> withdraw (real localnet, real proofs)", () => {
  const s: Partial<SharedState> = {};

  beforeAll(async () => {
    const net = await startLocalnet({ logToConsole: false });
    s.net = net;
    s.proverArtifactsDir = join(REPO_ROOT, "circuits", "target");
    s.poolAddress = poolPda(net.programIds.kakurePool)[0];
    s.assetIdBytes = assetId(net.mint);
    s.assetAddr = assetPda(net.programIds.kakurePool, s.assetIdBytes)[0];
    s.vault = await getAssociatedTokenAddress(net.mint, s.poolAddress, true);
    s.members = [];
    s.publicShares = new Map();

    // Real bug found by this workstream (see altHelper.ts's header comment): a real proof + its
    // public inputs makes EVERY kakure_pool instruction too big for a legacy 1232-byte transaction,
    // even the smallest circuit. Every real submission below goes through one shared v0 Address
    // Lookup Table instead, seeded here with every address that stays fixed for the whole scenario.
    const verifierIds = VERIFIER_ORDER.map((name) => net.programIds.verifiers[name]!);
    s.alt = await createSharedLookupTable(net.connection, net.payer, [
      net.programIds.kakurePool,
      ComputeBudgetProgram.programId,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      ...verifierIds,
      s.poolAddress,
      net.mint,
      s.vault,
      s.assetAddr,
      net.payerTokenAccount,
    ]);
  }, 120_000);

  afterAll(async () => {
    await s.net?.stop();
  });

  it(
    "step 1: initialize the pool with all 7 real verifiers, the fixture compliance key, and the cluster's genesis leaf",
    async () => {
      const net = s.net!;
      const genesisHashStr = await net.connection.getGenesisHash();
      const genesisHashBig = bytesToBigIntBE(new PublicKey(genesisHashStr).toBytes());
      // genesisLeaf now reduces genesisHash internally (packages/sdk/src/merkle/genesis.ts) --
      // this raw 256-bit value used to make it throw "greater or equal to field modulus".
      const gLeaf = await genesisLeaf(genesisHashBig);

      const builder = new TxBuilder(net.programIds.kakurePool);
      const verifiers = VERIFIER_ORDER.map((name) => {
        const id = net.programIds.verifiers[name];
        if (!id) throw new Error(`missing verifier program id for ${name}`);
        return id;
      });
      const ixs = builder.initialize(
        {
          compliancePkX: frToBytes32(new Fr(FIXTURE_COMPLIANCE_X)),
          compliancePkY: frToBytes32(new Fr(FIXTURE_COMPLIANCE_Y)),
          verifiers,
          genesisLeaf: frToBytes32(gLeaf),
        },
        {
          authority: net.payer.publicKey,
          programData: programDataAddress(net.programIds.kakurePool)[0],
        },
      );
      await assertFitsPacketLimit(net.connection, "initialize", ixs, s.alt!, net.payer);
      await sendV0(net.connection, ixs, s.alt!, net.payer);

      const acct = await net.connection.getAccountInfo(s.poolAddress!, "confirmed");
      expect(acct).not.toBeNull();
      const pool = decodePool(acct!.data);
      expect(pool.authority.equals(net.payer.publicKey)).toBe(true);
      expect(pool.paused).toBe(false);
      for (let i = 0; i < 7; i++) {
        expect(pool.verifiers[i]!.equals(verifiers[i]!)).toBe(true);
      }
    },
    60_000,
  );

  it(
    "step 2: five in-process signers run a real dealerless DKG (t=3,n=5), relayed through the real coordinator",
    async () => {
      const net = s.net!;
      const sessionId = Buffer.from(randomBytes(32)).toString("hex");
      const seeds = Array.from({ length: 5 }, () => randomBytes(32));
      const results = await Promise.all(
        seeds.map((seed) =>
          runDkgCeremony({
            coordinator: new CoordinatorClient(net.coordinatorUrl),
            sessionId,
            threshold: 3,
            memberCount: 5,
            ed25519Seed: new Uint8Array(seed),
            ed25519PublicKey: ed25519.getPublicKey(seed),
            context: DKG_CONTEXT,
            maxRounds: 200,
          }),
        ),
      );
      s.members = results.map((result, i) => ({ keypair: Keypair.fromSeed(seeds[i]!), result }));

      const gpk = results[0]!.gpk;
      for (const r of results) {
        expect(r.gpk[0]).toBe(gpk[0]);
        expect(r.gpk[1]).toBe(gpk[1]);
      }
      s.gpk = [gpk[0], gpk[1]];

      const contribs = [...results[0]!.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
      const gvs = await combineGroupViewContributions(contribs, [...gpk]);
      const { v } = await deriveGroupViewKeyFromSecret(gvs, [...gpk]);
      s.v = v;
      // slice-2 F-2: the group's canonical view secret, kept around so later steps can derive a
      // session-sealing key (`deriveSessionKeyFromGvsDecimal(s.gvsDecimal!, <that proposal's own
      // session id>)`) for whichever coordinator session a proposal actually lives on -- NOT
      // necessarily this DKG session id (step 5 posts its transfer proposal on a fresh one).
      s.gvsDecimal = gvs.toString();

      const dealerCommitmentsList = [...results[0]!.dealerCommitments.values()];
      for (const r of results) {
        s.publicShares!.set(r.myId.toString(), aggregatePublicShareAt(r.myId, dealerCommitmentsList));
      }

      expect(s.members).toHaveLength(5);
      expect(new Set(results.map((r) => r.myId.toString())).size).toBe(5);
    },
    120_000,
  );

  it(
    "step 3: depositor deposits SPL tokens as a MULTISIG note owned by the group (real deposit proof)",
    async () => {
      const net = s.net!;
      const gpk = s.gpk!;
      const counters = new InMemoryEphemeralCounterStore();
      const memberId = s.members![0]!.result.myId;

      const mint = await multisigDepositEph(s.v!, memberId, counters, [...gpk]);
      const owner = new Fr(await multisigOwner([...gpk]));
      const assetIdField = new Fr(bytesToBigIntBE(assetId(net.mint)));
      const cek = deriveCek(mint.eph, [...COMPLIANCE_PK]);
      const psi = await computePsi(cek);
      const noteFields = {
        noteVersion: new Fr(1n),
        assetId: assetIdField,
        noteType: new Fr(1n), // NOTE_TYPE_MULTISIG
        conditionsHash: new Fr(0n),
        value: DEPOSIT_AMOUNT,
        owner,
        psi,
        parents: new Fr(0n),
      };
      await leaf(noteFields); // sanity: recomputed independently by the scan in step 4

      const prover = nativeProverPort({ artifactsDir: s.proverArtifactsDir! });
      const t0 = Date.now();
      const bundle = await prover.prove(CircuitId.Deposit, {
        compliance_pubkey_x: "0x" + COMPLIANCE_PK[0].toString(16),
        compliance_pubkey_y: "0x" + COMPLIANCE_PK[1].toString(16),
        note: {
          note_version: noteFields.noteVersion.toString(),
          asset_id: noteFields.assetId.toString(),
          note_type: noteFields.noteType.toString(),
          conditions_hash: noteFields.conditionsHash.toString(),
          value: noteFields.value.toString(),
          owner: noteFields.owner.toString(),
          psi: noteFields.psi.toString(),
          parents: noteFields.parents.toString(),
        },
        eph: mint.eph.toString(),
      });
      // eslint-disable-next-line no-console
      console.log(`[timing] deposit proof: ${Date.now() - t0}ms`);
      expect(bundle.circuitId).toBe(CircuitId.Deposit);
      expect(bundle.publicInputs).toHaveLength(13);

      const builder = new TxBuilder(net.programIds.kakurePool);
      const ixs = builder.deposit(bundle, DEPOSIT_AMOUNT, {
        pool: s.poolAddress!,
        asset: s.assetAddr!,
        mint: net.mint,
        vault: s.vault!,
        depositorTokenAccount: net.payerTokenAccount,
        depositor: net.payer.publicKey,
        verifierProgram: net.programIds.verifiers.deposit!,
      });
      await assertFitsPacketLimit(net.connection, "deposit", ixs, s.alt!, net.payer);
      const sig = await sendV0(net.connection, ixs, s.alt!, net.payer);
      const txInfo = await net.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      // eslint-disable-next-line no-console
      console.log(`[timing] deposit tx CU consumed: ${txInfo?.meta?.computeUnitsConsumed}`);
      expect(txInfo?.meta?.err).toBeNull();
    },
    900_000,
  );

  it(
    "step 4: the group's MultisigScanEngine finds the deposited note and the group balance equals the deposit",
    async () => {
      const net = s.net!;
      const engine = await MultisigScanEngine.create(httpNotesTransport(net.indexerUrl), {
        v: s.v!,
        gpk: [...s.gpk!],
        compliancePk: [...COMPLIANCE_PK],
        memberIds: s.members!.map((m) => m.result.myId),
      });
      // Poll briefly: the indexer's live tail may lag the confirmed tx by a beat.
      let found: MultisigNoteView[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        found = await engine.sync(0);
        if (found.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(found).toHaveLength(1);
      const note = found[0]!;
      expect(note.note.value).toBe(DEPOSIT_AMOUNT);
      s.depositedNote = note;
    },
    // Workstream L diagnostic (root-caused, not a logic bug): under this shared box's CPU
    // contention, `MultisigScanEngine.create()` alone was measured taking 32+ seconds (real
    // Poseidon2/EC crypto work over a lookahead window), blowing past the original 30_000ms
    // budget even though ingestion and matching both succeed immediately once `create()`
    // returns. Widened so this step's correctness isn't gated on the box being idle.
    120_000,
  );

  it(
    "step 5: three of five signers propose + sign a transfer_multisig of 400_000 to a single-key recipient (real proof, tx confirmed)",
    async () => {
      const net = s.net!;
      const gpk = s.gpk!;
      const note = s.depositedNote!;

      const recipientKeypair = Keypair.generate();
      const recipientAccount = await SolanaAccount.fromKeypair(recipientKeypair);
      s.recipientKeypair = recipientKeypair;
      s.recipient = recipientAccount;
      const addr = await recipientAccount.canonicalIncomingAddress(0n);
      const recipientInKey = await recipientAccount.getIncomingKey(addr.index);
      const recipientInPub = addr.pub;

      const proposer = s.members![0]!.result;
      const merkle = new IndexerWitnessSource(indexerTransport(net.indexerUrl, () => note.leafIndex));
      const counters = new InMemoryEphemeralCounterStore();

      const assembled = await retryOnTransientWitnessMismatch(() =>
        assembleTransferMultisig(
          { merkle, counters },
          {
            gpk: [...gpk],
            v: s.v!,
            memberId: proposer.myId,
            compliancePk: [...COMPLIANCE_PK],
            oldNoteView: note,
            transferValue: TRANSFER_AMOUNT,
            recipientInPub: [...recipientInPub],
            recipientInKey,
            memoEph: randomEvenYScalar(), // must be even-y (mint::mint_incoming_note); distinct from changeEph
          },
        ),
      );

      const sessionId = Buffer.from(randomBytes(32)).toString("hex");
      const proposalId = "scenario-transfer-1";
      const coordinator = new CoordinatorClient(net.coordinatorUrl);
      // slice-2 F-2: this proposal lives on its OWN fresh session id (not the DKG's), so its
      // session-sealing key must be derived against THIS session id.
      const sessionKey = deriveSessionKeyFromGvsDecimal(s.gvsDecimal!, sessionId);
      await createTransferMultisigProposal(coordinator, sessionId, sessionKey, proposalId, assembled);

      const quorum = s.members!.slice(0, 3);
      await Promise.all(
        quorum.map((m) =>
          signProposal({
            coordinator: new CoordinatorClient(net.coordinatorUrl),
            sessionId,
            sessionKey,
            proposalId,
            myId: m.result.myId,
            mySecretShare: m.result.mySecretShare,
            gpk: [...gpk],
            threshold: 3,
            maxRounds: 200,
          }),
        ),
      );

      // The transfer_multisig nullifier PDA is deterministic from the note being spent, so it is
      // known before proving -- extend the shared lookup table with it now so the real submission
      // below (also carrying 24 real public inputs) fits under the 1232-byte tx limit.
      const nullifierBytes = frToBytes32(new Fr(note.nullifier.toBigInt()));
      const nullifierAddr = nullifierPda(net.programIds.kakurePool, nullifierBytes)[0];
      await extendSharedLookupTable(net.connection, net.payer, s.alt!, [nullifierAddr]);

      const prover = nativeProverPort({ artifactsDir: s.proverArtifactsDir! });
      // Workstream G: TxBuilder.transferMultisig resolves a root_index against the pool's CURRENT
      // root ring (rootIndexFor) -- fetch it now, right before proving+building, rather than
      // caching an earlier snapshot from the beforeAll block.
      const poolNow = await currentPool(net.connection, s.poolAddress!);
      const t0 = Date.now();
      const result = await executeProposal({
        coordinator: new CoordinatorClient(net.coordinatorUrl),
        sessionId,
        sessionKey,
        proposalId,
        gpk: [...gpk],
        threshold: 3,
        publicShares: s.publicShares!,
        prover: { prove: (inputs) => prover.prove(CircuitId.TransferMultisig, inputs) },
        buildInputs: (signature, proposal) =>
          buildTransferMultisigInputsFromProposal(signature, proposal, [...gpk]),
        buildInstructions: (bundle) => {
          const builder = new TxBuilder(net.programIds.kakurePool);
          return builder.transferMultisig(
            bundle as ProofBundle,
            {
              pool: s.poolAddress!,
              nullifier: nullifierAddr,
              payer: net.payer.publicKey,
              verifierProgram: net.programIds.verifiers.transfer_multisig!,
            },
            poolNow,
          );
        },
        maxRounds: 200,
        // No `send` here: executeProposal's own send path builds a legacy Transaction, which
        // cannot carry a lookup table. Send it ourselves via the shared ALT instead.
      });
      s.transferBundle = result.bundle as ProofBundle;
      await assertFitsPacketLimit(net.connection, "transfer_multisig", result.instructions, s.alt!, net.payer);
      const sig = await sendV0(net.connection, result.instructions, s.alt!, net.payer);
      // eslint-disable-next-line no-console
      console.log(`[timing] transfer_multisig proof+submit: ${Date.now() - t0}ms`);

      const txInfo = await net.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      // eslint-disable-next-line no-console
      console.log(`[timing] transfer_multisig tx CU consumed: ${txInfo?.meta?.computeUnitsConsumed}`);
      expect(txInfo?.meta?.err).toBeNull();
    },
    900_000,
  );

  it(
    "step 6: the recipient's ScanEngine sees 400_000; recipient withdraws it for exactly 400_000 SPL tokens (real withdraw proof)",
    async () => {
      const net = s.net!;
      const recipientAccount = s.recipient!;

      const keyRepo = new KeyRepository(recipientAccount);
      const utxoRepo = new UtxoRepository();
      const engine = new ScanEngine(httpNotesTransport(net.indexerUrl), keyRepo, utxoRepo, [
        ...COMPLIANCE_PK,
      ]);
      let notes: ReturnType<typeof utxoRepo.getAllNotes> = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        await engine.sync(0);
        notes = utxoRepo.getUnspentNotes();
        if (notes.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(notes).toHaveLength(1);
      const received = notes[0]!;
      expect(received.note.value).toBe(TRANSFER_AMOUNT);

      const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
        net.connection,
        net.payer,
        net.mint,
        s.recipientKeypair!.publicKey,
      );
      const recipientField32 = recipientField(recipientTokenAccount.address);

      const merkle = new IndexerWitnessSource(indexerTransport(net.indexerUrl, () => received.leafIndex));
      const w = await retryOnTransientWitnessMismatch(() => merkle.witnessFor(received.commitment));

      const changeValue = 0n;
      // Bug found running the real scenario (unrelated to slice-2, flagged and fixed here per the
      // "you are the integrator" instruction): `getSelfEphemeral(0n)` derives WHATEVER scalar
      // falls at index 0, with no even-y check -- `mint::mint_self_note` (main.nr:40) asserts the
      // resulting ephemeral public key's y is even (`even_y::is_even_y`, the self discovery tag
      // must be a single coordinate, `pub.x`), so an odd-y index 0 makes every real withdraw fail
      // Noir's own witness-generation assertion before a proof is even attempted -- roughly a
      // coin flip per run, since `recipientKeypair` is freshly generated each time. Use
      // `canonicalSelfTag` (the same even-y-rolling helper `canonicalIncomingAddress`/deposit
      // change notes use) to find the first even-y index from 0, then re-derive the ephemeral
      // scalar AT that index (deterministic, so it reproduces the same point `canonicalSelfTag`
      // found).
      const selfTag = await recipientAccount.canonicalSelfTag(0n);
      const changeEph = await recipientAccount.getSelfEphemeral(selfTag.index);
      const { mintSelfNote } = await import("@kakure/sdk/unsafe-sim");
      const selfSpendScalar = await recipientAccount.getSelfSpendKey();
      // Bug found running the real scenario past workstream G's tx-size fix (unrelated to wire
      // format -- flagged, fixed here per the "you are the integrator" instruction): `withdraw`'s
      // circuit (`circuits/standard/withdraw/src/main.nr`) asserts
      // `assert_parents_bound(change_note, [old_note_index, 0])`, i.e. the change note's `parents`
      // field must be `packParents([{leafIndex: old_note_index}, {leafIndex: 0}])`, NOT the
      // `mintSelfNote` default of zero (which is only correct for a note with no consumed parent,
      // e.g. a deposit). Omitting it made every real withdraw fail Noir's own witness-generation
      // assertion ("output parents not bound to consumed inputs") before a proof was even
      // attempted.
      const change = await mintSelfNote(
        changeEph,
        changeValue,
        selfSpendScalar,
        received.note.assetId,
        [...COMPLIANCE_PK],
        packParents([{ leafIndex: w.leafIndex }, { leafIndex: 0 }]),
      );

      const prover = nativeProverPort({ artifactsDir: s.proverArtifactsDir! });
      const t0 = Date.now();
      const bundle = await prover.prove(CircuitId.Withdraw, {
        withdraw_value: TRANSFER_AMOUNT.toString(),
        recipient: bytesToBigIntBE(recipientField32).toString(),
        intent_hash: "0",
        compliance_pubkey_x: "0x" + COMPLIANCE_PK[0].toString(16),
        compliance_pubkey_y: "0x" + COMPLIANCE_PK[1].toString(16),
        old_note: {
          note_version: "1",
          asset_id: received.note.assetId.toString(),
          note_type: received.note.noteType.toString(),
          conditions_hash: received.note.conditionsHash.toString(),
          value: received.note.value.toString(),
          owner: received.note.owner.toString(),
          psi: received.note.psi.toString(),
          parents: received.note.parents.toString(),
        },
        spend_scalar: received.spendScalar.toString(),
        old_note_index: w.leafIndex.toString(),
        old_note_path: w.siblings.map((f) => f.toString()),
        change_note: {
          note_version: change.note.noteVersion.toString(),
          asset_id: change.note.assetId.toString(),
          note_type: change.note.noteType.toString(),
          conditions_hash: change.note.conditionsHash.toString(),
          value: change.note.value.toString(),
          owner: change.note.owner.toString(),
          psi: change.note.psi.toString(),
          parents: change.note.parents.toString(),
        },
        change_eph: changeEph.toString(),
      });
      // eslint-disable-next-line no-console
      console.log(`[timing] withdraw proof: ${Date.now() - t0}ms`);
      expect(bundle.circuitId).toBe(CircuitId.Withdraw);
      expect(bundle.publicInputs).toHaveLength(17);

      const nullifierBytes = frToBytes32(new Fr(received.nullifier.toBigInt()));
      const nullifierAddr = nullifierPda(net.programIds.kakurePool, nullifierBytes)[0];
      // Extend the shared lookup table with this withdraw's nullifier PDA and the recipient's
      // (freshly created) token account -- both known now, both needed to fit the real 17-input
      // withdraw proof under the 1232-byte tx limit (see altHelper.ts).
      await extendSharedLookupTable(net.connection, net.payer, s.alt!, [
        nullifierAddr,
        recipientTokenAccount.address,
      ]);

      const poolNow = await currentPool(net.connection, s.poolAddress!);
      const builder = new TxBuilder(net.programIds.kakurePool);
      const ixs = builder.withdraw(
        bundle,
        TRANSFER_AMOUNT,
        {
          pool: s.poolAddress!,
          asset: s.assetAddr!,
          mint: net.mint,
          nullifier: nullifierAddr,
          vault: s.vault!,
          destinationTokenAccount: recipientTokenAccount.address,
          payer: net.payer.publicKey,
          verifierProgram: net.programIds.verifiers.withdraw!,
        },
        poolNow,
      );
      await assertFitsPacketLimit(net.connection, "withdraw", ixs, s.alt!, net.payer);
      const before = await net.connection.getTokenAccountBalance(recipientTokenAccount.address);
      const sig = await sendV0(net.connection, ixs, s.alt!, net.payer);
      const after = await net.connection.getTokenAccountBalance(recipientTokenAccount.address);
      const txInfo = await net.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      // eslint-disable-next-line no-console
      console.log(`[timing] withdraw tx CU consumed: ${txInfo?.meta?.computeUnitsConsumed}`);
      expect(BigInt(after.value.amount) - BigInt(before.value.amount)).toBe(TRANSFER_AMOUNT);
    },
    900_000,
  );

  it(
    "step 7a (negative): a proof against a tampered/unknown root fails with the pool's StaleRoot",
    async () => {
      const net = s.net!;
      const bundle = s.transferBundle!;
      const note = s.depositedNote!;
      const tampered: ProofBundle = {
        ...bundle,
        publicInputs: bundle.publicInputs.map((w, i) => {
          if (i !== 3) return w;
          const copy = Uint8Array.from(w);
          const lastIdx = copy.length - 1;
          copy[lastIdx] = (copy[lastIdx]! ^ 0xff) & 0xff; // flip the last byte of the root
          return copy;
        }),
      };
      const tamperedRoot = tampered.publicInputs[3]!;

      // Workstream G: TxBuilder.transferMultisig now resolves root_index CLIENT-SIDE
      // (rootIndexFor) before ever building the instruction, so a root that is genuinely nowhere
      // in the pool's ring throws RootNotInRingError immediately, never reaching the chain -- which
      // would test the SDK's own guard, not the on-chain `StaleRoot` check this step means to
      // exercise. Constructing a `PoolAccount` snapshot whose ring DOES contain `tamperedRoot`, but
      // at a slot (250) the REAL on-chain pool has never written, gets a `root_index` the client
      // resolves successfully while the chain's own `resolve_root` still rejects it as stale --
      // this is the equivalent of an attacker submitting a `root_index` for a ring slot that has
      // since been overwritten (or never existed), the actual scenario `StaleRoot` guards against.
      const NEVER_WRITTEN_SLOT = 250;
      const poolNow = await currentPool(net.connection, s.poolAddress!);
      // sanity: genuinely unwritten. `poolNow.roots[i]` is a `Buffer` (decodePool slices a
      // Buffer), so compare bytes directly rather than via `toEqual(new Uint8Array(32))` -- a
      // `Buffer` and a plain `Uint8Array` are never `toEqual` even with identical bytes.
      expect([...poolNow.roots[NEVER_WRITTEN_SLOT]!].every((b) => b === 0)).toBe(true);
      const riggedPool: PoolAccount = {
        ...poolNow,
        roots: poolNow.roots.map((r, i) => (i === NEVER_WRITTEN_SLOT ? tamperedRoot : r)),
      };

      const nullifierBytes = frToBytes32(new Fr(note.nullifier.toBigInt()));
      const builder = new TxBuilder(net.programIds.kakurePool);
      const ixs = builder.transferMultisig(
        tampered,
        {
          pool: s.poolAddress!,
          nullifier: nullifierPda(net.programIds.kakurePool, nullifierBytes)[0],
          payer: net.payer.publicKey,
          verifierProgram: net.programIds.verifiers.transfer_multisig!,
        },
        riggedPool,
      );
      let caught: unknown;
      try {
        await sendV0(net.connection, ixs, s.alt!, net.payer);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(decodePoolError(caught)).toBe("StaleRoot");
    },
    120_000,
  );

  it(
    "step 7b (negative): replaying the real transfer_multisig tx (same nullifier) fails with NullifierSpent",
    async () => {
      const net = s.net!;
      const bundle = s.transferBundle!;
      const note = s.depositedNote!;
      const nullifierBytes = frToBytes32(new Fr(note.nullifier.toBigInt()));
      const poolNow = await currentPool(net.connection, s.poolAddress!);
      const builder = new TxBuilder(net.programIds.kakurePool);
      const ixs = builder.transferMultisig(
        bundle,
        {
          pool: s.poolAddress!,
          nullifier: nullifierPda(net.programIds.kakurePool, nullifierBytes)[0],
          payer: net.payer.publicKey,
          verifierProgram: net.programIds.verifiers.transfer_multisig!,
        },
        poolNow,
      );
      let caught: unknown;
      try {
        await sendV0(net.connection, ixs, s.alt!, net.payer);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(decodePoolError(caught)).toBe("NullifierSpent");
    },
    120_000,
  );

  it("step 7c (negative): aggregating a t=3 signature from only 2 signers fails FROST verification", async () => {
    const gpk = s.gpk!;
    const message = encodeMessage(0x5750414en);
    const quorum = s.members!.slice(0, 2).map((m) => m.result);
    const rounds = new Map<bigint, Awaited<ReturnType<typeof commit>>>();
    for (const m of quorum) {
      rounds.set(m.myId, await commit(cs, m.myId, m.mySecretShare, randomBytes(32), randomBytes(32)));
    }
    const ids = quorum.map((m) => m.myId);
    const commitments = ids.map((id) => rounds.get(id)!.commitment);
    const zs: bigint[] = [];
    for (const m of quorum) {
      zs.push(
        await signShare(cs, m.myId, rounds.get(m.myId)!.nonces, m.mySecretShare, [...gpk], message, commitments),
      );
    }
    const rhos = await bindingFactors(cs, [...gpk], message, commitments);
    const R = groupCommitment(cs, commitments, rhos);
    const signature = aggregate(cs, R, zs);
    // Only 2 of the group's t=3 shares: Shamir interpolation over an insufficient set does not
    // reconstruct the group secret's contribution, so the resulting signature must NOT verify.
    expect(await verify(cs, [...gpk], message, signature)).toBe(false);
  });
});
