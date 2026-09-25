#!/usr/bin/env node
import { parseArgs } from "./config.js";
import { MessageStore } from "./db/store.js";
import { createLogger } from "./logger.js";
import { buildCoordinatorApi } from "./api/server.js";
import { startTtlSweep } from "./ttlSweep.js";

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const store = new MessageStore(config.dbPath);
  const logger = createLogger();
  const api = buildCoordinatorApi({ store, logger });
  api.attachWebSocket();
  const stopSweep = startTtlSweep(store, logger);

  await api.app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`kakure-coordinator listening on ${config.host}:${config.port}`);

  const shutdown = async (): Promise<void> => {
    stopSweep();
    await api.app.close();
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
