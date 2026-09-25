import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TxBuilder,
  CircuitId,
  decodePool,
  type InitializeAccounts,
  type DepositAccounts,
  type SpendAccounts,
  type JoinMultisigAccounts,
  type WithdrawAccounts,
  type ProofBundle,
  type PoolAccount,
} from "@kakure/sdk/solana";

/**
 * `kakure_pool`'s real, frozen contract (`programs/kakure_pool/src/{instruction,processor}.rs`, now
 * merged to main): instruction data is `borsh::to_vec(PoolInstruction)` -- one leading borsh enum-variant
 * tag byte, no Anchor sighash -- and events are `sol_log_data` under `kakure:<Name>` tags, both already
 * implemented for real in `@kakure/sdk/solana`'s `TxBuilder` and `packages/indexer`'s decoder. This client
 * is the thin e2e-only seam that turns `PoolInstructionRequest`'s generic name/args shape into a call on
 * the real `TxBuilder`, signs, and sends -- there is no more "TODO(contract)": B's contract landed and is
 * exercised for real by every step in `scenario.test.ts`.
 */
export interface PoolInstructionRequest {
  readonly name:
    | "initialize"
    | "set_verifier"
    | "rotate_compliance_key"
    | "set_paused"
    | "deposit"
    | "transfer"
    | "transfer_multisig"
    | "split_multisig"
    | "join_multisig"
    | "withdraw"
    | "withdraw_multisig";
  readonly args: Readonly<Record<string, unknown>>;
  readonly signers: readonly Keypair[];
}

export interface PoolClient {
  submit(request: PoolInstructionRequest): Promise<string>; // returns the tx signature
}

/** Kept for anything that still wants the old always-throws stub (e.g. a smoke test asserting the seam
 *  itself); the real path for `scenario.test.ts` is `RealPoolClient` below. */
export class NotYetImplementedPoolClient implements PoolClient {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async submit(_request: PoolInstructionRequest): Promise<string> {
    throw new Error(
      `TODO(contract): not wired for this instruction (program ${this.programId.toBase58()} on ${this.connection.rpcEndpoint})`,
    );
  }
}

function req<T>(args: Readonly<Record<string, unknown>>, key: string): T {
  if (!(key in args)) {
    throw new Error(`RealPoolClient: missing required arg '${key}'`);
  }
  return args[key] as T;
}

/**
 * Real submission: builds the exact instruction(s) for `request.name` via `TxBuilder`, wraps them in a
 * `Transaction` fee-paid by `request.signers[0]`, signs with every supplied signer, sends, and confirms.
 * `request.args` carries whatever that instruction's `TxBuilder` method needs (bundle/amount/accounts),
 * matching the method's own parameter names one for one -- see each `case` below.
 */
export class RealPoolClient implements PoolClient {
  private readonly builder: TxBuilder;

  constructor(
    private readonly connection: Connection,
    programId: PublicKey,
  ) {
    this.builder = new TxBuilder(programId);
  }

  /** Fetches and decodes the pool account fresh -- workstream G's spend builders resolve a
   *  `root_index` against the pool's CURRENT root ring (`TxBuilder`'s `rootIndexFor`), which
   *  changes with every prior instruction in an e2e scenario. */
  private async currentPool(poolAddress: PublicKey): Promise<PoolAccount> {
    const acct = await this.connection.getAccountInfo(poolAddress, "confirmed");
    if (!acct) throw new Error(`RealPoolClient: pool account ${poolAddress.toBase58()} not found`);
    return decodePool(acct.data);
  }

  async submit(request: PoolInstructionRequest): Promise<string> {
    const ixs = await this.buildInstructions(request);
    if (request.signers.length === 0) {
      throw new Error("RealPoolClient.submit: at least one signer (the fee payer) is required");
    }
    const feePayer = request.signers[0]!;
    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer.publicKey;
    const sig = await sendAndConfirmTransaction(this.connection, tx, [...request.signers], {
      commitment: "confirmed",
    });
    return sig;
  }

  private async buildInstructions(request: PoolInstructionRequest): Promise<TransactionInstruction[]> {
    const { name, args } = request;
    switch (name) {
      case "initialize":
        return this.builder.initialize(
          {
            compliancePkX: req<Uint8Array>(args, "compliancePkX"),
            compliancePkY: req<Uint8Array>(args, "compliancePkY"),
            verifiers: req<readonly PublicKey[]>(args, "verifiers"),
            genesisLeaf: req<Uint8Array>(args, "genesisLeaf"),
          },
          req<InitializeAccounts>(args, "accounts"),
        );
      case "set_verifier":
        return [
          this.builder.setVerifier(
            req<CircuitId>(args, "circuitId"),
            req<PublicKey>(args, "verifierProgram"),
            req<{ pool: PublicKey; authority: PublicKey }>(args, "accounts"),
          ),
        ];
      case "rotate_compliance_key":
        return [
          this.builder.rotateComplianceKey(
            req<Uint8Array>(args, "x"),
            req<Uint8Array>(args, "y"),
            req<{ pool: PublicKey; authority: PublicKey }>(args, "accounts"),
          ),
        ];
      case "set_paused":
        return [
          this.builder.setPaused(
            req<boolean>(args, "paused"),
            req<{ pool: PublicKey; authority: PublicKey }>(args, "accounts"),
          ),
        ];
      case "deposit":
        return this.builder.deposit(
          req<ProofBundle>(args, "bundle"),
          req<bigint>(args, "amount"),
          req<DepositAccounts>(args, "accounts"),
        );
      case "transfer": {
        const accounts = req<SpendAccounts>(args, "accounts");
        return this.builder.transfer(
          req<ProofBundle>(args, "bundle"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      case "transfer_multisig": {
        const accounts = req<SpendAccounts>(args, "accounts");
        return this.builder.transferMultisig(
          req<ProofBundle>(args, "bundle"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      case "split_multisig": {
        const accounts = req<SpendAccounts>(args, "accounts");
        return this.builder.splitMultisig(
          req<ProofBundle>(args, "bundle"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      case "join_multisig": {
        const accounts = req<JoinMultisigAccounts>(args, "accounts");
        return this.builder.joinMultisig(
          req<ProofBundle>(args, "bundle"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      case "withdraw": {
        const accounts = req<WithdrawAccounts>(args, "accounts");
        return this.builder.withdraw(
          req<ProofBundle>(args, "bundle"),
          req<bigint>(args, "amount"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      case "withdraw_multisig": {
        const accounts = req<WithdrawAccounts>(args, "accounts");
        return this.builder.withdrawMultisig(
          req<ProofBundle>(args, "bundle"),
          req<bigint>(args, "amount"),
          accounts,
          await this.currentPool(accounts.pool),
        );
      }
      default: {
        const _never: never = name;
        throw new Error(`RealPoolClient: unhandled instruction ${String(_never)}`);
      }
    }
  }
}
