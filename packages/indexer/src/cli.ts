#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { SolanaChainSource } from "./chain/solanaSource.js";
import { parseArgs } from "./config.js";
import { IndexerStore } from "./db/store.js";
import type { KakurePoolIdl } from "./events/idl.js";
import { Ingestor } from "./ingest/ingest.js";
import { LeanIMT } from "./tree/leanImt.js";
import { buildIndexerApi } from "./api/server.js";

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const idl = JSON.parse(readFileSync(config.idlPath, "utf8")) as KakurePoolIdl;

  const store = new IndexerStore(config.dbPath);
  const tree = new LeanIMT(32);
  const chain = new SolanaChainSource(config.rpcUrl);
  const ingestor = new Ingestor({ chain, store, tree, idl, programId: config.programId });

  ingestor.hydrateTree();
  const stopLiveTail = ingestor.startLiveTail();

  const app = buildIndexerApi({ store, tree, ingestor });
  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`kakure-indexer listening on ${config.host}:${config.port}`);

  // Do not hold the HTTP API hostage to a slow public RPC. Some shared Solana endpoints can take
  // minutes to answer `getSignaturesForAddress`; the live subscription must already be attached so
  // new events are not missed while the historical cursor catches up.
  void ingestor.backfill().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("ingest: historical backfill failed", err);
  });

  const shutdown = async (): Promise<void> => {
    stopLiveTail();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
