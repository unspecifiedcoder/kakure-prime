#!/usr/bin/env node
import { nativeProverPort } from "@kakure/prover";
import { buildHelperApi, generateToken } from "./server.js";

const DEFAULT_PORT = 8787;

async function main(): Promise<void> {
  const port = process.env.KAKURE_HELPER_PORT ? Number(process.env.KAKURE_HELPER_PORT) : DEFAULT_PORT;
  const token = generateToken();
  const { app } = buildHelperApi({ proverPort: nativeProverPort(), token });

  await app.listen({ port, host: "127.0.0.1" });
  // eslint-disable-next-line no-console
  console.log(`kakure-helper listening on http://127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(`token: ${token}`);
  // eslint-disable-next-line no-console
  console.log("Paste this token into the treasury app's Settings page to enable proving.");

  const shutdown = async (): Promise<void> => {
    await app.close();
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
