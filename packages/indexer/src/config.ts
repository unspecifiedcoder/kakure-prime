export interface IndexerConfig {
  port: number;
  rpcUrl: string;
  programId: string;
  idlPath: string;
  dbPath: string;
  /** slice-2 F-8: defaults to loopback-only, same rationale as the coordinator's `--host`. */
  host: string;
}

/** Parse `--port --rpc --program-id --idl --db --host` flags (plus sane defaults) into an IndexerConfig. */
export function parseArgs(argv: string[]): IndexerConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for --${key}`);
      }
      flags.set(key, value);
      i++;
    }
  }

  const port = flags.has("port") ? Number(flags.get("port")) : 8787;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port must be a positive integer");
  }
  const rpcUrl = flags.get("rpc") ?? "http://127.0.0.1:8899";
  const programId = flags.get("program-id");
  if (!programId) {
    throw new Error("--program-id is required");
  }
  const idlPath = flags.get("idl");
  if (!idlPath) {
    throw new Error("--idl is required");
  }
  const dbPath = flags.get("db") ?? "./kakure-indexer.sqlite";
  const host = flags.get("host") ?? "127.0.0.1";

  return { port, rpcUrl, programId, idlPath, dbPath, host };
}
