import { readFile } from "node:fs/promises";
import BN from "bn.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

const keypairPath = process.env.KAKURE_DEPLOYER_KEYPAIR;
if (!keypairPath) throw new Error("KAKURE_DEPLOYER_KEYPAIR must point to a devnet-only keypair JSON file");

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!rpcUrl.includes("devnet")) throw new Error("This evidence trade is devnet-only");

const poolAddress = new PublicKey(process.env.METEORA_DBC_POOL ?? "58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW");
const buyLamports = new BN(process.env.METEORA_BUY_LAMPORTS ?? "20000000");
const secret = JSON.parse(await readFile(keypairPath, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");

const pool = await client.state.getPool(poolAddress);
if (!pool) throw new Error("Meteora DBC pool was not found");
const config = await client.state.getPoolConfig(pool.poolState.config);
if (!config) throw new Error("Meteora DBC config was not found");

const quote = client.pool.swapQuote({
  virtualPool: pool,
  config,
  swapBaseForQuote: false,
  amountIn: buyLamports,
  slippageBps: 100,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint: new BN(Math.floor(Date.now() / 1000)),
});

const transaction = await client.pool.swap({
  owner: payer.publicKey,
  payer: payer.publicKey,
  pool: poolAddress,
  amountIn: buyLamports,
  minimumAmountOut: quote.minimumAmountOut,
  swapBaseForQuote: false,
  referralTokenAccount: null,
});
const signature = await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: "confirmed" });
const updated = await client.state.getPool(poolAddress);
const curveProgress = await client.state.getPoolQuoteTokenCurveProgress(poolAddress);

console.log(JSON.stringify({
  network: "devnet",
  pool: poolAddress.toBase58(),
  buyer: payer.publicKey.toBase58(),
  inputLamports: buyLamports.toString(10),
  quotedReceiptAmount: quote.outputAmount.toString(10),
  minimumReceiptAmount: quote.minimumAmountOut.toString(10),
  signature,
  hasSwap: updated?.poolState.hasSwap === 1,
  quoteReserveLamports: updated?.poolState.quoteReserve.toString(10),
  curveProgress,
}, null, 2));
