export interface CoordinatorConfig {
  port: number;
  dbPath: string;
  /** slice-2 F-8: defaults to loopback-only. The coordinator has no auth of its own, no rate
   *  limiting, and no per-session write token (see F-3 item 3) -- binding `0.0.0.0` by default
   *  put it on the network unconditionally with no way to opt out short of a firewall. */
  host: string;
}

/** Parse `--port --db --host` flags into a CoordinatorConfig. */
export function parseArgs(argv: string[]): CoordinatorConfig {
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

  const port = flags.has("port") ? Number(flags.get("port")) : 8788;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port must be a positive integer");
  }
  const dbPath = flags.get("db") ?? "./kakure-coordinator.sqlite";
  const host = flags.get("host") ?? "127.0.0.1";

  return { port, dbPath, host };
}
