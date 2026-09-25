import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

// Resolved from this file's own location, not `process.cwd()`: `pnpm --filter @kakure/e2e test` runs
// with cwd = `e2e/`, and vitest may be invoked from anywhere -- but this module always lives at
// `<repoRoot>/e2e/localnet.ts`, so the repo root is one directory up regardless of caller cwd.
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Workstream F's localnet harness (spec §7, master plan Workstream F.1).
 *
 * Starts `solana-test-validator` with `kakure_pool`, `mock_verifier` and the 7 real Sunspot verifier
 * programs loaded at genesis, airdrops a payer, mints an SPL token, and spawns the indexer + coordinator
 * CLIs pointed at it. All paths default to the sibling worktrees this task was briefed against, but are
 * overridable so this harness still works once B/E's artifacts move into this repo proper.
 */

const HOME = process.env.HOME ?? "/root";

export interface VerifierProgram {
  readonly circuitName: string;
  readonly soPath: string;
  readonly keypairPath: string;
}

export interface LocalnetProgramPaths {
  readonly kakurePoolSo: string;
  readonly kakurePoolKeypair: string;
  readonly mockVerifierSo: string;
  readonly mockVerifierKeypair: string;
  readonly verifiers: readonly VerifierProgram[];
}

const CIRCUIT_NAMES = [
  "deposit",
  "transfer",
  "withdraw",
  "transfer_multisig",
  "split_multisig",
  "join_multisig",
  "withdraw_multisig",
] as const;

// Everything now lives in this repo proper (main d4fb144 merged A/B/C/D/E): `programs/deploy/` holds
// the pool + mock-verifier `.so`/keypair, `circuits/target/` holds the 7 real Sunspot verifier `.so`s.
// The env overrides are kept for anyone who still wants to point at out-of-tree artifacts.
const DEFAULT_PROGRAMS_DEPLOY_DIR =
  process.env.KAKURE_PROGRAMS_DEPLOY_DIR ?? join(REPO_ROOT, "programs", "deploy");
const DEFAULT_CIRCUITS_TARGET_DIR =
  process.env.KAKURE_CIRCUITS_TARGET_DIR ?? join(REPO_ROOT, "circuits", "target");

export function defaultProgramPaths(): LocalnetProgramPaths {
  const deployDir = DEFAULT_PROGRAMS_DEPLOY_DIR;
  const circuitsTargetDir = DEFAULT_CIRCUITS_TARGET_DIR;
  return {
    kakurePoolSo: join(deployDir, "kakure_pool.so"),
    kakurePoolKeypair: join(deployDir, "kakure_pool-keypair.json"),
    mockVerifierSo: join(deployDir, "mock_verifier.so"),
    mockVerifierKeypair: join(deployDir, "mock_verifier-keypair.json"),
    verifiers: CIRCUIT_NAMES.map((name) => ({
      circuitName: name,
      soPath: join(circuitsTargetDir, `${name}.so`),
      keypairPath: join(circuitsTargetDir, `${name}-keypair.json`),
    })),
  };
}

export interface LocalnetOptions {
  readonly programPaths?: LocalnetProgramPaths;
  readonly solanaCliBin?: string;
  readonly indexerCliPath?: string; // built packages/indexer dist/cli.js
  readonly indexerIdlPath?: string; // Anchor IDL the indexer decodes emit_cpi! events with
  readonly coordinatorCliPath?: string; // built packages/coordinator dist/cli.js
  readonly airdropSol?: number;
  readonly mintDecimals?: number;
  readonly mintAmount?: bigint;
  readonly logToConsole?: boolean;
}

export interface Localnet {
  readonly rpcUrl: string;
  readonly rpcPort: number;
  readonly indexerUrl: string;
  readonly coordinatorUrl: string;
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly mint: PublicKey;
  readonly payerTokenAccount: PublicKey;
  readonly programIds: {
    readonly kakurePool: PublicKey;
    readonly mockVerifier: PublicKey;
    readonly verifiers: Record<string, PublicKey>;
  };
  stop(): Promise<void>;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("findFreePort: unexpected address"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

function pubkeyOf(keypairPath: string, solanaKeygenBin: string): Promise<PublicKey> {
  return new Promise((resolve, reject) => {
    const child = spawn(solanaKeygenBin, ["pubkey", keypairPath]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`solana-keygen pubkey ${keypairPath} exited ${code}`));
        return;
      }
      resolve(new PublicKey(out.trim()));
    });
  });
}

function waitForHttp(url: string, timeoutMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async (): Promise<void> => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) {
          resolve();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        reject(new Error(`waitForHttp: ${url} did not respond within ${timeoutMs}ms`));
        return;
      }
      setTimeout(() => void attempt(), intervalMs);
    };
    void attempt();
  });
}

async function waitForRpcHealth(connection: Connection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await connection.getVersion();
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`waitForRpcHealth: RPC did not become healthy within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function spawnLogged(
  label: string,
  command: string,
  args: string[],
  opts: { logToConsole: boolean; cwd?: string },
): ChildProcess {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
  if (opts.logToConsole) {
    child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  }
  return child;
}

/** Starts a fresh localnet: validator (with all 9 programs genesis-loaded) + indexer + coordinator. */
export async function startLocalnet(opts: LocalnetOptions = {}): Promise<Localnet> {
  const programPaths = opts.programPaths ?? defaultProgramPaths();
  const solanaBinDir = join(HOME, ".local", "share", "solana", "install", "active_release", "bin");
  // `opts.solanaCliBin` is accepted for forward-compat (a future step may shell out to the `solana` CLI
  // directly) but unused today: mint/airdrop go through `@solana/web3.js`/`@solana/spl-token` instead.
  void opts.solanaCliBin;
  const solanaTestValidatorBin = join(solanaBinDir, "solana-test-validator");
  const solanaKeygenBin = join(solanaBinDir, "solana-keygen");
  const logToConsole = opts.logToConsole ?? false;

  const requiredArtifacts: Array<[label: string, path: string]> = [
    ["kakure_pool.so", programPaths.kakurePoolSo],
    ["kakure_pool-keypair.json", programPaths.kakurePoolKeypair],
    ["mock_verifier.so", programPaths.mockVerifierSo],
    ["mock_verifier-keypair.json", programPaths.mockVerifierKeypair],
  ];
  for (const v of programPaths.verifiers) {
    requiredArtifacts.push([`${v.circuitName}.so`, v.soPath]);
    requiredArtifacts.push([`${v.circuitName}-keypair.json`, v.keypairPath]);
  }
  for (const [label, path] of requiredArtifacts) {
    if (!existsSync(path)) {
      throw new Error(`startLocalnet: missing program artifact ${label} at ${path}`);
    }
  }

  const rpcPort = await findFreePort();
  const faucetPort = await findFreePort();
  const gossipPort = await findFreePort();
  const dynamicRangeStart = await findFreePort();
  // solana-test-validator rejects a dynamic-port-range narrower than ~25 ports ("Port range is too
  // small"); 50 leaves headroom for its gossip/TPU/repair ports without risking a second rejection.
  const dynamicRangeEnd = dynamicRangeStart + 50;
  const ledgerDir = mkdtempSync(join(tmpdir(), "kakure-e2e-ledger-"));

  // Generated here (rather than after the validator starts, as before) so its pubkey can be baked
  // in at genesis as kakure_pool's upgrade authority -- see the `--upgradeable-program` arg below
  // (F9 fix: `initialize` now requires `authority == ProgramData.upgrade_authority_address`, so
  // kakure_pool can no longer be loaded with upgrades permanently disabled like the other 8
  // programs, which have no such check).
  const payer = Keypair.generate();

  const bpfProgramArgs: string[] = [];
  bpfProgramArgs.push(
    "--upgradeable-program",
    programPaths.kakurePoolKeypair,
    programPaths.kakurePoolSo,
    payer.publicKey.toBase58(),
  );
  bpfProgramArgs.push("--bpf-program", programPaths.mockVerifierKeypair, programPaths.mockVerifierSo);
  for (const v of programPaths.verifiers) {
    bpfProgramArgs.push("--bpf-program", v.keypairPath, v.soPath);
  }

  const validator = spawnLogged(
    "validator",
    solanaTestValidatorBin,
    [
      "--reset",
      "--quiet",
      "--ledger",
      ledgerDir,
      "--rpc-port",
      String(rpcPort),
      "--faucet-port",
      String(faucetPort),
      "--gossip-port",
      String(gossipPort),
      "--dynamic-port-range",
      `${dynamicRangeStart}-${dynamicRangeEnd}`,
      ...bpfProgramArgs,
    ],
    { logToConsole },
  );

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const connection = new Connection(rpcUrl, "confirmed");

  const cleanups: Array<() => void> = [];
  let validatorExited = false;
  validator.on("exit", () => {
    validatorExited = true;
  });

  try {
    await waitForRpcHealth(connection, 60_000);
    if (validatorExited) throw new Error("startLocalnet: validator exited during startup");

    const airdropSol = opts.airdropSol ?? 10;
    const sig = await connection.requestAirdrop(payer.publicKey, airdropSol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    const mint = await createMint(connection, payer, payer.publicKey, null, opts.mintDecimals ?? 6);
    const payerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    await mintTo(
      connection,
      payer,
      mint,
      payerAta.address,
      payer,
      opts.mintAmount ?? 1_000_000_000n,
    );

    const kakurePoolId = await pubkeyOf(programPaths.kakurePoolKeypair, solanaKeygenBin);
    const mockVerifierId = await pubkeyOf(programPaths.mockVerifierKeypair, solanaKeygenBin);
    const verifierIds: Record<string, PublicKey> = {};
    for (const v of programPaths.verifiers) {
      verifierIds[v.circuitName] = await pubkeyOf(v.keypairPath, solanaKeygenBin);
    }

    const indexerPort = await findFreePort();
    const coordinatorPort = await findFreePort();
    const indexerUrl = `http://127.0.0.1:${indexerPort}`;
    const coordinatorUrl = `http://127.0.0.1:${coordinatorPort}`;

    // The indexer's `--idl` flag wants ITS OWN small IDL schema (packages/indexer/src/events/idl.ts's
    // `KakurePoolIdl`: `events:[{name}]` + `types:[{name,type:{kind,fields}}]`), which is NOT the same
    // shape as `packages/sdk/src/solana/idl/kakure_pool.json` (a human-readable doc file with a
    // completely different `events:[{tag,fields}]` layout, meant for people, not the decoder). Passing
    // the doc file here would make `decodeProgramDataLine` throw on every real event (no `types` entry
    // matches). `e2e/fixtures/kakure_pool.indexer-idl.json` is a hand-kept copy of the indexer's own
    // `DEFAULT_KAKURE_POOL_IDL`, checked against `programs/kakure_pool/src/events.rs`'s real field
    // layout (this was the bug: F found and fixed it -- see the workstream report).
    const indexerCliPath =
      opts.indexerCliPath ?? join(REPO_ROOT, "packages", "indexer", "dist", "cli.js");
    const indexerIdlPath =
      opts.indexerIdlPath ??
      join(REPO_ROOT, "e2e", "fixtures", "kakure_pool.indexer-idl.json");
    const indexerArgs = [
      indexerCliPath,
      "--port",
      String(indexerPort),
      "--rpc",
      rpcUrl,
      "--program-id",
      kakurePoolId.toBase58(),
      "--idl",
      indexerIdlPath,
      "--db",
      ":memory:",
    ];
    const indexer = spawnLogged("indexer", "node", indexerArgs, { logToConsole });

    const coordinatorCliPath =
      opts.coordinatorCliPath ?? join(REPO_ROOT, "packages", "coordinator", "dist", "cli.js");
    const coordinator = spawnLogged(
      "coordinator",
      "node",
      [coordinatorCliPath, "--port", String(coordinatorPort), "--db", ":memory:"],
      { logToConsole },
    );

    cleanups.push(() => {
      indexer.kill("SIGTERM");
      coordinator.kill("SIGTERM");
    });

    await waitForHttp(`${indexerUrl}/root`, 30_000);
    const zeroSessionId = "0".repeat(64);
    await waitForHttp(`${coordinatorUrl}/sessions/${zeroSessionId}/messages?since=0`, 30_000);

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      for (const c of cleanups) c();
      validator.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    };
    const sigintHandler = (): void => {
      void stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", sigintHandler);
    cleanups.push(() => process.removeListener("SIGINT", sigintHandler));

    return {
      rpcUrl,
      rpcPort,
      indexerUrl,
      coordinatorUrl,
      connection,
      payer,
      mint,
      payerTokenAccount: payerAta.address,
      programIds: { kakurePool: kakurePoolId, mockVerifier: mockVerifierId, verifiers: verifierIds },
      stop,
    };
  } catch (err) {
    validator.kill("SIGTERM");
    throw err;
  }
}
