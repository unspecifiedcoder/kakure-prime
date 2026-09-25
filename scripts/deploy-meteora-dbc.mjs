import { readFile } from "node:fs/promises";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

const keypairPath = process.env.KAKURE_DEPLOYER_KEYPAIR;
if (!keypairPath) throw new Error("KAKURE_DEPLOYER_KEYPAIR must point to a devnet-only keypair JSON file");

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!rpcUrl.includes("devnet")) throw new Error("This hackathon deployment script is devnet-only");

const secret = JSON.parse(await readFile(keypairPath, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");
const config = Keypair.generate();
const receiptMint = Keypair.generate();
const quoteMint = new PublicKey("So11111111111111111111111111111111111111112");

// Equity receipts need early price discovery without permanent meme-token fees.
// The launch fee decays from 100 bps to the protocol minimum of 25 bps over 24 hours,
// then the pool graduates to DAMM v2 at the configured market-cap threshold.
const curve = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 25, numberOfPeriod: 24, totalDuration: 86_400 },
    },
    dynamicFeeEnabled: true,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 50,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps200,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 45,
    partnerPermanentLockedLiquidityPercentage: 5,
    creatorLiquidityPercentage: 45,
    creatorPermanentLockedLiquidityPercentage: 5,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Timestamp,
  initialMarketCap: 1,
  migrationMarketCap: 10,
});

const configTransaction = await client.partner.createConfig({
  config: config.publicKey,
  feeClaimer: payer.publicKey,
  leftoverReceiver: payer.publicKey,
  payer: payer.publicKey,
  quoteMint,
  ...curve,
});
const configSignature = await sendAndConfirmTransaction(connection, configTransaction, [payer, config], {
  commitment: "confirmed",
});

const poolTransaction = await client.creator.createPool({
  name: "Kakure Shielded Equity Receipt",
  symbol: "kEQT",
  uri: "https://kakure-prime.vercel.app/kakure-equity-receipt.json",
  payer: payer.publicKey,
  poolCreator: payer.publicKey,
  config: config.publicKey,
  baseMint: receiptMint.publicKey,
});
const poolSignature = await sendAndConfirmTransaction(connection, poolTransaction, [payer, receiptMint], {
  commitment: "confirmed",
});
const pool = await client.state.getPoolByBaseMint(receiptMint.publicKey);
if (!pool) throw new Error("Meteora DBC pool was not readable after confirmation");

console.log(JSON.stringify({
  network: "devnet",
  owner: payer.publicKey.toBase58(),
  config: config.publicKey.toBase58(),
  receiptMint: receiptMint.publicKey.toBase58(),
  pool: pool.publicKey.toBase58(),
  configSignature,
  poolSignature,
}, null, 2));
