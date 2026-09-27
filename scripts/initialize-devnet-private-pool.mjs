import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TxBuilder,
  decodePool,
  genesisLeaf,
  poolPda,
  programDataAddress,
} from "../packages/sdk/dist/solana/index.js";

const FIXTURE_COMPLIANCE_X =
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n;
const FIXTURE_COMPLIANCE_Y =
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n;

function bytesToBigIntBE(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigintToBytes32(value) {
  const output = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("field value does not fit in 32 bytes");
  return output;
}

const rpcUrl = process.env.SOLANA_RPC_URL;
const payerPath = process.env.KAKURE_PAYER_KEYPAIR;
if (!rpcUrl) throw new Error("SOLANA_RPC_URL is required");
if (!payerPath) throw new Error("KAKURE_PAYER_KEYPAIR is required");

const deployment = JSON.parse(
  await readFile(new URL("../deployments/solana-devnet.json", import.meta.url), "utf8"),
);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(resolve(payerPath), "utf8"))),
);
if (payer.publicKey.toBase58() !== deployment.payer) {
  throw new Error(`payer mismatch: expected ${deployment.payer}`);
}

const connection = new Connection(rpcUrl, "confirmed");
const programId = new PublicKey(deployment.poolProgram.address);
const pool = poolPda(programId)[0];
const existing = await connection.getAccountInfo(pool, "confirmed");
if (existing) {
  const state = decodePool(existing.data);
  console.log(JSON.stringify({ status: "already-initialized", pool: pool.toBase58(), authority: state.authority.toBase58() }));
  process.exit(0);
}

const deposit = new PublicKey(deployment.verifiers.deposit.address);
const withdraw = new PublicKey(deployment.verifiers.withdraw.address);
const transferMultisig = new PublicKey(deployment.verifiers.transferMultisig.address);

// This public deployment intentionally enables only the demonstrated path. Unsupported circuit
// slots reuse an executable verifier address but cannot accept a mismatched circuit proof.
const verifiers = [
  deposit,
  transferMultisig,
  withdraw,
  transferMultisig,
  transferMultisig,
  transferMultisig,
  withdraw,
];

const genesisHash = await connection.getGenesisHash();
const gLeaf = await genesisLeaf(bytesToBigIntBE(new PublicKey(genesisHash).toBytes()));
const builder = new TxBuilder(programId);
const instructions = builder.initialize(
  {
    compliancePkX: bigintToBytes32(FIXTURE_COMPLIANCE_X),
    compliancePkY: bigintToBytes32(FIXTURE_COMPLIANCE_Y),
    verifiers,
    genesisLeaf: new Uint8Array(gLeaf.toBuffer()),
  },
  {
    authority: payer.publicKey,
    programData: programDataAddress(programId)[0],
  },
);

const transaction = new Transaction().add(...instructions);
const latest = await connection.getLatestBlockhash("confirmed");
transaction.feePayer = payer.publicKey;
transaction.recentBlockhash = latest.blockhash;
transaction.sign(payer);
const signature = await connection.sendRawTransaction(transaction.serialize(), {
  maxRetries: 5,
  skipPreflight: false,
});
const confirmationDeadline = Date.now() + 90_000;
for (;;) {
  const response = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = response.value[0];
  if (status?.err) throw new Error(`pool initialization failed: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
  if (Date.now() > confirmationDeadline) {
    throw new Error(`timed out waiting for pool initialization ${signature}`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
}
const account = await connection.getAccountInfo(pool, "confirmed");
if (!account) throw new Error("pool account missing after confirmed initialization");
const state = decodePool(account.data);
if (!state.authority.equals(payer.publicKey)) throw new Error("initialized pool authority mismatch");
if (!state.verifiers[0]?.equals(deposit)) throw new Error("deposit verifier mismatch");
if (!state.verifiers[2]?.equals(withdraw)) throw new Error("withdraw verifier mismatch");
if (!state.verifiers[3]?.equals(transferMultisig)) throw new Error("transfer_multisig verifier mismatch");

console.log(JSON.stringify({ status: "initialized", signature, pool: pool.toBase58() }));
