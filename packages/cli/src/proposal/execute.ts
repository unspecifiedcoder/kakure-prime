/**
 * `execute`: aggregate (see `proposal.ts`) -> prove -> build instruction(s) -> (optionally) send.
 * The proof-input/instruction-building steps are dependency-injected because they are per-circuit
 * (I-1) and require actual note/Merkle-witness data the state machine itself has no opinion about
 * -- callers supply `buildInputs`/`buildInstructions`, real code wires them to
 * `@kakure/sdk`'s `tx/assemble.ts`+`tx/plan.ts` note selection and `@kakure/prover`'s per-circuit
 * `InputMap` builders; tests here supply fakes, exactly as the master plan specifies for this
 * workstream ("no validator required").
 */
import type { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { CoordinatorClient } from "../coordinatorClient.js";
import type { Point } from "@kakure/sdk/tss";
import { aggregateProposal, type ProposalPayload } from "./proposal.js";

export interface ProverLike<Bundle> {
  prove(inputs: Record<string, unknown>): Promise<Bundle>;
}

export interface ExecuteProposalOptions<Bundle> {
  coordinator: CoordinatorClient;
  sessionId: string;
  /** slice-2 F-2: opens the proposal/nonce/share envelopes. Derive with
   *  `deriveSessionKey(gvs, sessionId)` (`crypto/sessionSeal.ts`). */
  sessionKey: Uint8Array;
  proposalId: string;
  gpk: Point;
  threshold: number;
  publicShares: ReadonlyMap<string, Point>;
  prover: ProverLike<Bundle>;
  /** Turns the aggregated FROST signature + the proposal's own details into the exact `InputMap`
   *  the target circuit expects (I-1 order); real callers reuse `@kakure/prover`'s per-circuit
   *  builders (`buildTransferMultisigInputMap`, etc). */
  buildInputs: (
    signature: { R: Point; z: bigint },
    proposal: ProposalPayload,
  ) => Record<string, unknown>;
  /** Turns a `ProofBundle` into the instruction(s) to send; real callers use
   *  `@kakure/sdk/solana`'s `TxBuilder`. */
  buildInstructions: (bundle: Bundle, proposal: ProposalPayload) => TransactionInstruction[];
  maxRounds?: number;
  /** When present, sends the built instructions; when absent, `execute` is a dry run that only
   *  returns the built instructions (used by every test in this package). */
  send?: { connection: Connection; feePayer: Keypair; sign?: (tx: Transaction) => void };
}

export interface ExecuteProposalResult<Bundle> {
  bundle: Bundle;
  instructions: TransactionInstruction[];
  signature?: string; // transaction signature, only when `send` was supplied
}

export async function executeProposal<Bundle>(
  opts: ExecuteProposalOptions<Bundle>,
): Promise<ExecuteProposalResult<Bundle>> {
  const { signature, proposal } = await aggregateProposal({
    coordinator: opts.coordinator,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    proposalId: opts.proposalId,
    gpk: opts.gpk,
    threshold: opts.threshold,
    publicShares: opts.publicShares,
    maxRounds: opts.maxRounds,
  });

  const inputs = opts.buildInputs({ R: signature.R as Point, z: signature.z }, proposal);
  const bundle = await opts.prover.prove(inputs);
  const instructions = opts.buildInstructions(bundle, proposal);

  if (!opts.send) return { bundle, instructions };

  const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(...instructions);
  tx.feePayer = opts.send.feePayer.publicKey;
  const txSig = await sendAndConfirmTransaction(opts.send.connection, tx, [opts.send.feePayer]);
  return { bundle, instructions, signature: txSig };
}
