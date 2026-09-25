/**
 * Spec §5/§6 demo flow, end to end: a 3-of-5 treasury is created (real DKG over the real
 * coordinator), funded, and pays 3 recipients in one proposal (real transfer_multisig proofs);
 * one recipient then opens their claim link in a REAL browser and sees the private payment.
 *
 * Treasury-side setup (DKG, deposit, the payroll proposals) runs as direct library calls in
 * `beforeAll` -- exactly like `e2e/scenario.test.ts` does for the same operations, and for the
 * same reason: those genuinely happen on N different signers' own machines, never in one browser,
 * so there is no "browser flow" to drive for them. What Playwright actually drives is the ONE
 * thing that's real end-user browser surface here: the recipient's claim page.
 *
 * Never run this alongside another `solana-test-validator` on this machine -- check
 * `pgrep -f solana-test-validator` first. Real Groth16 proving + a real 5-signer DKG take real
 * wall-clock minutes; this is why `playwright.config.ts` sets a 20-minute test timeout and why the
 * justfile's `e2e-payroll` target says to run this in the foreground.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { Fr } from "@aztec/foundation/fields";
import { genesisLeaf, programDataAddress } from "@kakure/sdk/solana";
import {
  TxBuilder,
  poolPda,
  assetPda,
  assetId,
  decodePool,
  createSharedLookupTable,
  type SharedLookupTable,
} from "@kakure/sdk/solana";
import { SolanaAccount, InMemoryEphemeralCounterStore, MultisigScanEngine, httpNotesTransport } from "@kakure/sdk";
import { nativeProverPort } from "@kakure/prover";
import { CoordinatorClient, runDkgCeremony } from "@kakure/cli";
import { deriveGroupViewKeyFromSecret } from "@kakure/sdk/frost";
import { combineGroupViewContributions } from "@kakure/sdk/tss";
import { startLocalnet, REPO_ROOT, type Localnet } from "../../../e2e/localnet.js";
import { depositToTreasury, payOneRecipient } from "../src/lib/treasuryFlows.js";
import type { GroupRecord } from "../src/lib/treasury.js";
import type { ConnectedWallet } from "../src/lib/wallet.js";
import { myReceiveAddress, encodeReceiveAddress } from "../src/lib/receiveAddress.js";
import { encodeClaimToken } from "../src/lib/claimToken.js";

const THRESHOLD = 3;
const MEMBER_COUNT = 5;
const DEPOSIT_AMOUNT = 1_000_000n;
const RECIPIENT_AMOUNTS = [400_000n, 300_000n, 200_000n]; // 3 recipients, spec's "not 5, to keep runtime down"
const DKG_CONTEXT = 0x4b616b757265n; // "Kakure"
// Overridable so this can point at another worktree's already-built artifacts (`just
// build-circuits` -- real Sunspot compile+setup -- takes a long time); defaults to this repo's own.
const PROVER_ARTIFACTS_DIR = process.env.KAKURE_CIRCUITS_TARGET_DIR ?? join(REPO_ROOT, "circuits", "target");
const VERIFIER_ORDER = [
  "deposit",
  "transfer",
  "withdraw",
  "transfer_multisig",
  "split_multisig",
  "join_multisig",
  "withdraw_multisig",
] as const;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
function frToBytes32(f: Fr): Uint8Array {
  return new Uint8Array(f.toBuffer());
}

function walletFromKeypair(kp: Keypair): ConnectedWallet {
  return {
    publicKey: kp.publicKey,
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      const { ed25519 } = await import("@noble/curves/ed25519");
      return ed25519.sign(message, kp.secretKey.slice(0, 32));
    },
    async signTransaction<T extends { serialize?: unknown }>(tx: T): Promise<T> {
      // `treasuryFlows.ts` only ever hands this a `VersionedTransaction`.
      (tx as unknown as VersionedTransaction).sign([kp]);
      return tx;
    },
  };
}

test.describe("payroll demo (spec §5/§6)", () => {
  let net: Localnet;
  let alt: SharedLookupTable;
  let previewProcess: ChildProcess | undefined;
  let group: GroupRecord;
  let claimTokens: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(20 * 60 * 1000); // real Groth16 proving + a real 5-signer DKG
    net = await startLocalnet({ logToConsole: false });
    const poolAddress = poolPda(net.programIds.kakurePool)[0];
    const assetIdBytes = assetId(net.mint);
    const assetAddr = assetPda(net.programIds.kakurePool, assetIdBytes)[0];
    const vault = await getAssociatedTokenAddress(net.mint, poolAddress, true);

    const verifierIds = VERIFIER_ORDER.map((name) => net.programIds.verifiers[name]!);
    alt = await createSharedLookupTable(net.connection, net.payer, [
      net.programIds.kakurePool,
      ComputeBudgetProgram.programId,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      ...verifierIds,
      poolAddress,
      net.mint,
      vault,
      assetAddr,
      net.payerTokenAccount,
    ]);

    // Step 1: initialize the pool (mirrors e2e/scenario.test.ts step 1).
    const genesisHashStr = await net.connection.getGenesisHash();
    const gLeaf = await genesisLeaf(bytesToBigIntBE(new PublicKey(genesisHashStr).toBytes()));
    const builder = new TxBuilder(net.programIds.kakurePool);
    // Any fixed BJJ point works here as the compliance key for this demo -- no compliance ring
    // decryption is exercised by this test, only the pool's own on-chain check that a submitted
    // proof was bound to the SAME key the pool was initialized with (see `note/mint.ts`).
    const compliancePkX = new Fr(0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n);
    const compliancePkY = new Fr(0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n);
    const ixs = builder.initialize(
      {
        compliancePkX: frToBytes32(compliancePkX),
        compliancePkY: frToBytes32(compliancePkY),
        verifiers: verifierIds,
        genesisLeaf: frToBytes32(gLeaf),
      },
      { authority: net.payer.publicKey, programData: programDataAddress(net.programIds.kakurePool)[0] },
    );
    await sendV0(net.connection, ixs, alt, net.payer);

    // Step 2: 5 in-process signers run a real DKG (t=3,n=5) over the real coordinator.
    const sessionId = randomBytes(32).toString("hex");
    const seeds = Array.from({ length: MEMBER_COUNT }, () => randomBytes(32));
    const { ed25519 } = await import("@noble/curves/ed25519");
    const results = await Promise.all(
      seeds.map((seed) =>
        runDkgCeremony({
          coordinator: new CoordinatorClient(net.coordinatorUrl),
          sessionId,
          threshold: THRESHOLD,
          memberCount: MEMBER_COUNT,
          ed25519Seed: new Uint8Array(seed),
          ed25519PublicKey: ed25519.getPublicKey(seed),
          context: DKG_CONTEXT,
          maxRounds: 200,
        }),
      ),
    );
    const gpk = results[0]!.gpk;
    const contribs = [...results[0]!.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
    const gvs = await combineGroupViewContributions(contribs, [...gpk]);
    const groupView = await deriveGroupViewKeyFromSecret(gvs, [...gpk]);

    group = {
      sessionId,
      name: "Payroll demo",
      threshold: THRESHOLD,
      memberCount: MEMBER_COUNT,
      myId: results[0]!.myId.toString(),
      participantIds: results[0]!.participantIds.map((id) => id.toString()),
      gpk: { x: gpk[0].toString(16), y: gpk[1].toString(16) },
      mySecretShare: results[0]!.mySecretShare.toString(),
      groupViewKey: {
        gvs: gvs.toString(),
        v: groupView.v.toString(),
        V: { x: groupView.V[0].toString(16), y: groupView.V[1].toString(16) },
        roll: groupView.roll.toString(),
      },
      dealerCommitments: Object.fromEntries(
        [...results[0]!.dealerCommitments].map(([id, c]) => [
          id.toString(),
          c.map((p) => ({ x: p[0].toString(16), y: p[1].toString(16) })),
        ]),
      ),
      ceremonyKeypairSecretB64: "",
    };

    // Step 3: fund the treasury (a real deposit proof) via treasuryFlows.depositToTreasury, using
    // the localnet's already-funded payer as the "connected wallet".
    const depositor = walletFromKeypair(net.payer);
    const depositResult = await depositToTreasury({
      connection: net.connection,
      wallet: depositor,
      programId: net.programIds.kakurePool,
      mint: net.mint,
      amount: DEPOSIT_AMOUNT,
      gpk: [gpk[0], gpk[1]],
      groupViewSecret: BigInt(groupView.v.toString()),
      depositorMemberId: results[0]!.myId,
      proverPort: nativeProverPort({ artifactsDir: PROVER_ARTIFACTS_DIR }),
      alt,
    });
    const depositTxInfo = await net.connection.getTransaction(depositResult.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (depositTxInfo?.meta?.err) {
      throw new Error(`deposit transaction failed on-chain: ${JSON.stringify(depositTxInfo.meta.err)} logs: ${JSON.stringify(depositTxInfo.meta.logMessages)}`);
    }

    // Step 4: the group's MultisigScanEngine finds the deposited note.
    const scanEngine = await MultisigScanEngine.create(httpNotesTransport(net.indexerUrl), {
      v: new Fr(BigInt(groupView.v.toString())),
      gpk: [gpk[0], gpk[1]],
      compliancePk: [compliancePkX.toBigInt(), compliancePkY.toBigInt()],
      memberIds: group.participantIds.map((id) => BigInt(id)),
    });
    // Poll briefly: the indexer's live tail may lag the confirmed deposit tx by a beat (same
    // caveat e2e/scenario.test.ts's step 4 documents).
    let sourceNote: import("@kakure/sdk/frost").MultisigNoteView | undefined;
    for (let attempt = 0; attempt < 20 && !sourceNote; attempt++) {
      const notes = await scanEngine.sync(0);
      sourceNote = notes.find((n) => !n.isIncoming);
      if (!sourceNote) await new Promise((r) => setTimeout(r, 500));
    }
    if (!sourceNote) throw new Error("deposit note not found after sync");

    // Step 5: pay 3 recipients, one transfer_multisig proposal each, sharing one coordinator
    // session. Each recipient's account is a normal SolanaAccount seeded from a random signature
    // (standing in for "the recipient connected their wallet once already and shared their pay
    // address" -- see receiveAddress.ts's doc comment); the proving/signing quorum is 3 of the 5
    // in-process signers (the DKG ceremony's own real secret shares, not a fake).
    const quorum = results.slice(0, THRESHOLD).map((r) => ({ myId: r.myId, secretShare: r.mySecretShare }));
    const payer = walletFromKeypair(net.payer);
    const counters = new InMemoryEphemeralCounterStore();

    for (let i = 0; i < RECIPIENT_AMOUNTS.length; i++) {
      const recipientSig = randomBytes(64);
      const recipientAccount = await SolanaAccount.fromAccountSignature(recipientSig);
      const receiveAddr = await myReceiveAddress(recipientAccount, 0n);

      const result = await payOneRecipient({
        connection: net.connection,
        wallet: payer,
        programId: net.programIds.kakurePool,
        coordinatorUrl: net.coordinatorUrl,
        indexerUrl: net.indexerUrl,
        sessionId: randomBytes(32).toString("hex"), // one proposal-session per row is fine here
        proposalId: `demo-row-${i}`,
        group,
        proverPort: nativeProverPort({ artifactsDir: PROVER_ARTIFACTS_DIR }),
        alt,
        sourceNote,
        recipient: receiveAddr,
        amount: RECIPIENT_AMOUNTS[i]!,
        quorum,
        ephemeralCounters: counters,
      });
      sourceNote = result.changeNote;

      // Claim link: no secrets, just where/what to scan (spec §1.2/§4).
      claimTokens.push(
        encodeClaimToken({
          indexerUrl: net.indexerUrl,
          incomingAddressHint: encodeReceiveAddress(receiveAddr).slice(0, 12),
          fromLeaf: 0,
          toLeaf: 1_000_000,
          programId: net.programIds.kakurePool.toBase58(),
          mint: net.mint.toBase58(),
          rpcUrl: net.rpcUrl,
        }),
      );
      // Stash the recipient's identity for the browser step below via a side channel: the claim
      // page derives its own account from a wallet signature, so the browser needs the SAME
      // signature bytes this recipient "already has" -- passed via the init script, not the link.
      recipientSignatures.push(recipientSig);
    }

    // Serve the built web app.
    previewProcess = spawn("pnpm", ["exec", "vite", "preview", "--port", "4173", "--strictPort"], {
      cwd: join(REPO_ROOT, "apps", "web"),
      stdio: "pipe",
    });
    await waitForHttp("http://127.0.0.1:4173", 30_000);
  });

  test.afterAll(async () => {
    previewProcess?.kill();
    await net?.stop();
  });

  test("a recipient opens their claim link and sees the exact private amount", async ({ page }) => {
    const i = 0; // the 400_000-unit recipient
    await page.addInitScript(
      ({ sigB64 }: { sigB64: string }) => {
        const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
        (window as unknown as { isPhantomInstalled: boolean }).isPhantomInstalled = true;
        (window as unknown as { phantom: unknown }).phantom = {
          solana: {
            isPhantom: true,
            isConnected: false,
            publicKey: { toBytes: () => new Uint8Array(32) }, // never checked against anything downstream
            async connect() {
              (this as { isConnected: boolean }).isConnected = true;
            },
            async signMessage() {
              return { signature: sig };
            },
            on() {},
            off() {},
          },
        };
      },
      { sigB64: Buffer.from(recipientSignatures[i]!).toString("base64") },
    );

    await page.goto(`/#/claim/${claimTokens[i]}`);
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByText(/you were paid/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(RECIPIENT_AMOUNTS[i]!.toString())).toBeVisible();
  });
});

const recipientSignatures: Uint8Array[] = [];

async function sendV0(
  connection: Localnet["connection"],
  ixs: import("@solana/web3.js").TransactionInstruction[],
  altTable: SharedLookupTable,
  payer: Keypair,
): Promise<string> {
  const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  const { blockhash } = await connection.getLatestBlockhash();
  const altAccount = await altTable.account(connection);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([altAccount]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not become reachable within ${timeoutMs}ms`);
}
