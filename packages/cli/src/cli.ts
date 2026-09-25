#!/usr/bin/env node
/**
 * `kakure` CLI entry point. Command bodies delegate to the tested library functions in
 * `commands/` and `proposal/`; this file is argument parsing + I/O only.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Command } from "commander";
import { defaultConfigPath, defaultKeystorePath, loadConfig } from "./config.js";
import { readKeystoreFile } from "./keystore.js";
import { runKeygen } from "./commands/keygen.js";
import { runGroupCeremony } from "./commands/group.js";
import { computeBalance } from "./commands/balance.js";

/**
 * slice-2 F-11: a `readline` prompt over a plain `process.stdout` echoes every keystroke of the
 * passphrase to the terminal (and to any scrollback/session recording). This `Writable` writes
 * the prompt text itself (so the "Passphrase: " label still shows) but swallows everything
 * `readline` echoes back per keystroke while the interface is muted -- the standard workaround
 * (`@inquirer/password` does the same thing internally) since Node's `readline` has no built-in
 * "don't echo" mode for a `Promise`-based interface.
 */
function mutedOutput(realOutput: NodeJS.WritableStream): Writable {
  let muted = false;
  const out = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) realOutput.write(chunk);
      callback();
    },
  });
  (out as Writable & { mute: () => void; unmute: () => void }).mute = () => {
    muted = true;
  };
  (out as Writable & { mute: () => void; unmute: () => void }).unmute = () => {
    muted = false;
  };
  return out;
}

async function promptPassphrase(label = "Passphrase"): Promise<string> {
  if (process.env.KAKURE_PASSPHRASE !== undefined) return process.env.KAKURE_PASSPHRASE;
  const muteable = mutedOutput(process.stdout) as Writable & { mute: () => void; unmute: () => void };
  const rl = createInterface({ input: process.stdin, output: muteable, terminal: true });
  process.stdout.write(`${label}: `);
  muteable.mute();
  try {
    const value = await rl.question("");
    return value;
  } finally {
    muteable.unmute();
    process.stdout.write("\n");
    rl.close();
  }
}

export function buildCli(): Command {
  const program = new Command();
  program.name("kakure").description("Kakure: shielded FROST-multisig treasury on Solana").version("0.1.0");

  program
    .command("keygen")
    .description("Generate a new Solana keypair and write it to the encrypted keystore")
    .option("--keystore <path>", "keystore file path", defaultKeystorePath())
    .action(async (opts: { keystore: string }) => {
      const passphrase = await promptPassphrase("New passphrase");
      const { publicKey } = await runKeygen({ keystorePath: opts.keystore, passphrase });
      console.log(`generated keypair: ${publicKey}`);
      console.log(`keystore written to: ${opts.keystore}`);
    });

  const group = program.command("group").description("FROST multisig group ceremony (DKG)");

  group
    .command("create")
    .description("Create a new group DKG session and run the ceremony as its first member")
    .requiredOption("--threshold <t>", "signing threshold", (v) => parseInt(v, 10))
    .requiredOption("--members <n>", "total member count", (v) => parseInt(v, 10))
    .option("--keystore <path>", "keystore file path", defaultKeystorePath())
    .option("--group-store <path>", "where to write the encrypted group record")
    .action(async (opts: { threshold: number; members: number; keystore: string; groupStore?: string }) => {
      const config = await loadConfig();
      const passphrase = await promptPassphrase();
      const keypair = await readKeystoreFile(opts.keystore, passphrase);
      const record = await runGroupCeremony({
        coordinatorUrl: config.coordinatorUrl,
        threshold: opts.threshold,
        memberCount: opts.members,
        keypair,
        groupStorePath: opts.groupStore ?? `${defaultConfigPath()}/../groups/${Date.now()}.json`,
        passphrase,
      });
      console.log(`session: ${record.sessionId}`);
      console.log(`gpk: (0x${record.gpk.x}, 0x${record.gpk.y})`);
      console.log(`share the session id above with the other ${opts.members - 1} member(s):`);
      console.log(`  kakure group join ${record.sessionId} --threshold ${opts.threshold} --members ${opts.members}`);
    });

  group
    .command("join <session>")
    .description("Join an existing group DKG session")
    .requiredOption("--threshold <t>", "signing threshold", (v) => parseInt(v, 10))
    .requiredOption("--members <n>", "total member count", (v) => parseInt(v, 10))
    .option("--keystore <path>", "keystore file path", defaultKeystorePath())
    .option("--group-store <path>", "where to write the encrypted group record")
    .action(
      async (
        session: string,
        opts: { threshold: number; members: number; keystore: string; groupStore?: string },
      ) => {
        const config = await loadConfig();
        const passphrase = await promptPassphrase();
        const keypair = await readKeystoreFile(opts.keystore, passphrase);
        const record = await runGroupCeremony({
          coordinatorUrl: config.coordinatorUrl,
          sessionId: session,
          threshold: opts.threshold,
          memberCount: opts.members,
          keypair,
          groupStorePath: opts.groupStore ?? `${defaultConfigPath()}/../groups/${session}.json`,
          passphrase,
        });
        console.log(`joined session ${record.sessionId} as member ${record.myId}`);
        console.log(`gpk: (0x${record.gpk.x}, 0x${record.gpk.y})`);
      },
    );

  program
    .command("balance")
    .description("Show the group's spendable note balances, by asset")
    .requiredOption("--group-store <path>", "encrypted group record path")
    .action(async (opts: { groupStore: string }) => {
      const config = await loadConfig();
      const passphrase = await promptPassphrase();
      const { readEncryptedJsonFile } = await import("./keystore.js");
      const record = await readEncryptedJsonFile<import("./commands/group.js").GroupRecord>(
        opts.groupStore,
        passphrase,
      );
      const rows = await computeBalance(config.indexerUrl, record);
      if (rows.length === 0) {
        console.log("no spendable notes found");
        return;
      }
      for (const row of rows) {
        console.log(`asset ${row.assetId}: ${row.total} (${row.noteCount} note(s))`);
      }
    });

  program
    .command("deposit")
    .description("Build a deposit instruction for a mint/amount (dry run; printed, not sent)")
    .requiredOption("--mint <pubkey>", "SPL mint")
    .requiredOption("--amount <amount>", "amount, base units")
    .action((opts: { mint: string; amount: string }) => {
      console.log(
        `deposit: mint=${opts.mint} amount=${opts.amount} -- ` +
          "note assembly + proving requires a funded owner account and indexer connectivity; " +
          "wire via @kakure/prover's prove(CircuitId.Deposit, ...) and @kakure/sdk/solana's TxBuilder.deposit().",
      );
    });

  const propose = program.command("propose").description("Propose a spend for the group to sign");
  for (const kind of ["transfer", "split", "join", "withdraw"] as const) {
    propose
      .command(kind)
      .description(`Propose a ${kind}`)
      .requiredOption("--session <id>", "group session id")
      .requiredOption("--group-store <path>", "encrypted group record path (for the session-sealing key)")
      .requiredOption("--message <hex>", "the circuit's msg_* commitment, as hex")
      .option("--details <json>", "free-form JSON details for co-signers to review", "{}")
      .action(async (opts: { session: string; groupStore: string; message: string; details: string }) => {
        const config = await loadConfig();
        const passphrase = await promptPassphrase();
        const { readEncryptedJsonFile } = await import("./keystore.js");
        const { createProposal } = await import("./proposal/proposal.js");
        const { deriveSessionKeyFromGvsDecimal } = await import("./crypto/sessionSeal.js");
        const proposalId = `${kind}-${Date.now()}`;
        const { CoordinatorClient } = await import("./coordinatorClient.js");
        const record = await readEncryptedJsonFile<import("./commands/group.js").GroupRecord>(
          opts.groupStore,
          passphrase,
        );
        const sessionKey = deriveSessionKeyFromGvsDecimal(record.groupViewKey.gvs, opts.session);
        await createProposal(new CoordinatorClient(config.coordinatorUrl), opts.session, sessionKey, {
          kind,
          proposalId,
          messageHex: opts.message,
          details: JSON.parse(opts.details),
        });
        console.log(`proposal ${proposalId} posted to session ${opts.session}`);
      });
  }

  program
    .command("sign <proposal>")
    .description("Countersign a proposal (FROST round 1 + 2)")
    .requiredOption("--session <id>", "group session id")
    .requiredOption("--group-store <path>", "encrypted group record path")
    .action(async (proposalId: string, opts: { session: string; groupStore: string }) => {
      const config = await loadConfig();
      const passphrase = await promptPassphrase();
      const { readEncryptedJsonFile } = await import("./keystore.js");
      const { CoordinatorClient } = await import("./coordinatorClient.js");
      const { signProposal } = await import("./proposal/proposal.js");
      const { pointFromHex } = await import("./dkg/pointHex.js");
      const { deriveSessionKeyFromGvsDecimal } = await import("./crypto/sessionSeal.js");
      const record = await readEncryptedJsonFile<import("./commands/group.js").GroupRecord>(
        opts.groupStore,
        passphrase,
      );
      await signProposal({
        coordinator: new CoordinatorClient(config.coordinatorUrl),
        sessionId: opts.session,
        sessionKey: deriveSessionKeyFromGvsDecimal(record.groupViewKey.gvs, opts.session),
        proposalId,
        myId: BigInt(record.myId),
        mySecretShare: BigInt(record.mySecretShare),
        gpk: pointFromHex(record.gpk),
        threshold: record.threshold,
      });
      console.log(`signed proposal ${proposalId}`);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildCli();
  await program.parseAsync(process.argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
