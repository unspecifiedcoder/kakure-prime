import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * Moved here from `e2e/altHelper.ts` (workstream G): every non-deposit `kakure_pool` instruction,
 * even after compressing the proof to 192 bytes and swapping a 32-byte root for a 1-byte
 * `root_index` (see `programs/kakure_pool/src/instruction.rs`'s module docs and `txBuilder.ts`),
 * still carries a full 32-byte pubkey per referenced account -- an Address Lookup Table is what
 * keeps EVERY instruction (proof-bearing or not) comfortably under Solana's 1232-byte packet
 * limit, not just the biggest ones, so this is now a first-class part of the SDK any chain-facing
 * caller (the e2e scenario, the CLI, a wallet) needs, not an e2e-only test fixture.
 *
 * Real bugs found by workstream F while first running the real scenario against a real validator
 * (kept here verbatim -- still true, and still the reason this file's shape looks the way it does):
 *
 * 1. EVERY `kakure_pool` instruction that carries a real Groth16 proof + its public inputs is too
 *    big for a legacy Solana transaction's 1232-byte packet limit -- even `deposit`, the SMALLEST
 *    circuit (13 public inputs, pre-workstream-G), overflows by ~100 bytes ("Transaction too large:
 *    1329 > 1232") with a real ~388-byte proof. `transfer_multisig`/`withdraw`/`withdraw_multisig`
 *    (17-24 inputs) were worse. Invisible to every prior test because litesvm/mock-verifier tests
 *    use tiny fake proofs, and no prior e2e run had submitted a real proof to a real validator.
 *    Fixed with a standard v0-transaction + Address Lookup Table: every account referenced through
 *    the ALT costs 1 byte in the compiled message instead of 32. Workstream G's wire-format
 *    shrink (compressed proof, root_index) fixes the two circuits that were OVER the limit even
 *    with an ALT (`transfer`/`transfer_multisig`/`split_multisig`); the ALT stays because it is
 *    what buys every ix -- deposit included -- real margin against future growth, not just enough
 *    to clear 1232 bytes exactly.
 *
 * 2. `Connection.confirmTransaction`'s default (blockhash-based) strategy subscribes over the RPC
 *    websocket for the signature notification. `solana-test-validator` does not serve pubsub on
 *    the port `@solana/web3.js` guesses (rpcPort + 1) when only `--rpc-port` (not also a matching
 *    `--rpc-pubsub-port`) is passed -- the repeated, previously-dismissed-as-benign "ws error:
 *    connect ECONNREFUSED 127.0.0.1:<rpcPort+1>" log lines are exactly this. The upshot: any code
 *    path that reaches `confirmTransaction` directly (as opposed to going through
 *    `sendAndConfirmTransaction`, which has its own more defensive fallback) HANGS until the
 *    caller's own test timeout, with no thrown error at all. Fixed by never calling
 *    `confirmTransaction` here: every confirm below is a bare `getSignatureStatuses` HTTP poll
 *    loop, which has no websocket dependency at all.
 *
 * 3. The spec-minimum "usable the slot after last extended" rule is NOT enough margin on real
 *    validator builds observed so far. A v0 transaction referencing a lookup table extended only 1
 *    slot ago is accepted by preflight simulation (no error at all) but then never actually gets
 *    included in a block -- it silently vanishes from the validator's queue, and
 *    `getSignatureStatuses` polls forever returning null for it. Waiting a double-digit number of
 *    extra slots (empirically ~8-10 was enough in a minimal repro; this uses a larger, safer
 *    margin -- at least 20, see `ALT_WARMUP_EXTRA_SLOTS`) before using a newly-extended table
 *    avoids it entirely.
 */

export interface SharedLookupTable {
  address: PublicKey;
  account(connection: Connection): Promise<AddressLookupTableAccount>;
}

/** Polls `getSignatureStatuses` (plain HTTP, no websocket) until the signature is at least
 *  `confirmed`, or `timeoutMs` elapses. Does NOT throw on a program-level failure -- callers that
 *  care must inspect `getTransaction(...).meta.err` (or pass `throwOnError: true`) themselves. */
export async function pollForSignature(
  connection: Connection,
  signature: string,
  opts: { timeoutMs?: number; intervalMs?: number; throwOnError?: boolean } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (attempt === 1 || attempt % 10 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[alt] poll attempt ${attempt} for ${signature}: ${JSON.stringify(status ?? null)}`);
    }
    if (status) {
      const confirmed =
        status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
      if (confirmed || status.confirmations === null /* finalized/rooted */) {
        if (opts.throwOnError && status.err) {
          // Shaped so this package's `decodePoolError` (which reads `err.transactionError`, a
          // {InstructionError: [index, {Custom: n}]}-shaped object) can decode this directly.
          throw Object.assign(
            new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`),
            { transactionError: status.err },
          );
        }
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `pollForSignature: ${signature} did not reach 'confirmed' within ${timeoutMs}ms (last status: ${JSON.stringify(status)})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function sendAndPoll(
  connection: Connection,
  vtx: VersionedTransaction,
  opts: { throwOnError?: boolean } = {},
): Promise<string> {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[alt] sendTransaction start`);
  const signature = await connection.sendTransaction(vtx, {
    maxRetries: 5,
    preflightCommitment: "confirmed",
  });
  // eslint-disable-next-line no-console
  console.log(`[alt] sendTransaction returned sig=${signature} after ${Date.now() - t0}ms`);
  await pollForSignature(connection, signature, { throwOnError: opts.throwOnError ?? true });
  // eslint-disable-next-line no-console
  console.log(`[alt] confirmed after ${Date.now() - t0}ms total`);
  return signature;
}

/** Minimum slots to wait past a lookup-table extension before referencing it in a transaction --
 *  see this file's header comment, point 3. Callers needing a stricter guarantee may wait longer;
 *  this is a floor, not a target. */
export const ALT_WARMUP_EXTRA_SLOTS = 20;

async function waitForActivation(
  connection: Connection,
  altAddress: PublicKey,
  extendedAtSlot: number,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const slot = await connection.getSlot("confirmed");
    if (slot > extendedAtSlot + ALT_WARMUP_EXTRA_SLOTS) {
      const info = await connection.getAddressLookupTable(altAddress);
      if (info.value) return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `alt: lookup table ${altAddress.toBase58()} did not activate within the wait budget`,
  );
}

async function legacySend(
  connection: Connection,
  ixs: readonly TransactionInstruction[],
  authority: Keypair,
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [...ixs],
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(message);
  vtx.sign([authority]);
  return sendAndPoll(connection, vtx, { throwOnError: true });
}

/** Creates a fresh lookup table owned by `authority`, extends it with `addresses`, and waits for
 *  it to become usable (see `ALT_WARMUP_EXTRA_SLOTS`). May be extended further later via
 *  `extendSharedLookupTable`. */
export async function createSharedLookupTable(
  connection: Connection,
  authority: Keypair,
  addresses: readonly PublicKey[],
): Promise<SharedLookupTable> {
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot,
  });
  const ixs = [createIx];
  if (addresses.length > 0) {
    ixs.push(
      AddressLookupTableProgram.extendLookupTable({
        payer: authority.publicKey,
        authority: authority.publicKey,
        lookupTable: altAddress,
        addresses: [...addresses],
      }),
    );
  }
  const sig = await legacySend(connection, ixs, authority);
  const confirmedTx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  await waitForActivation(connection, altAddress, confirmedTx?.slot ?? recentSlot);

  return {
    address: altAddress,
    async account(conn: Connection) {
      const info = await conn.getAddressLookupTable(altAddress);
      if (!info.value) throw new Error(`alt: lookup table ${altAddress.toBase58()} not found`);
      return info.value;
    },
  };
}

/** Adds more addresses to an existing lookup table and waits for them to become usable. Safe to
 *  call with addresses already present (Solana dedupes on-chain; this just wastes a little
 *  rent-exempt space if called redundantly, never errors). */
export async function extendSharedLookupTable(
  connection: Connection,
  authority: Keypair,
  alt: SharedLookupTable,
  addresses: readonly PublicKey[],
): Promise<void> {
  if (addresses.length === 0) return;
  const ix = AddressLookupTableProgram.extendLookupTable({
    payer: authority.publicKey,
    authority: authority.publicKey,
    lookupTable: alt.address,
    addresses: [...addresses],
  });
  const sig = await legacySend(connection, [ix], authority);
  const confirmedTx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  await waitForActivation(connection, alt.address, confirmedTx?.slot ?? 0);
}

/**
 * Builds a v0 transaction from `instructions` against `alt`, signs with `feePayer` (+ any extra
 * signers), sends, and confirms via plain HTTP polling (see this file's header comment for why not
 * `connection.confirmTransaction`). Throws if the transaction fails preflight OR fails on-chain.
 */
export async function sendV0(
  connection: Connection,
  instructions: readonly TransactionInstruction[],
  alt: SharedLookupTable,
  feePayer: Keypair,
  extraSigners: readonly Keypair[] = [],
): Promise<string> {
  const altAccount = await alt.account(connection);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message([altAccount]);
  const vtx = new VersionedTransaction(message);
  vtx.sign([feePayer, ...extraSigners]);
  return sendAndPoll(connection, vtx, { throwOnError: true });
}

/**
 * Every account a spend instruction (`transfer`/`transfer_multisig`/`split_multisig`/
 * `join_multisig`/`withdraw`/`withdraw_multisig`) OR `deposit` references, EXCLUDING the
 * top-level instruction's own program id (`kakure_pool`'s program id, and the `ComputeBudget`
 * program id from the prepended compute-budget instruction) -- a v0 message's top-level
 * instruction program ids must be static (present directly in the message, not resolved through
 * a lookup table), but every ACCOUNT an instruction merely references, INCLUDING a CPI target like
 * the verifier program `kakure_pool` invokes internally, may live in the ALT. This is exactly the
 * account set each of these lists must be extended with: `pool`, the per-instruction PDAs
 * (nullifier(s)/asset), `mint`/`vault`/token accounts, well-known program ids
 * (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` / the associated-token-account program /
 * `SystemProgram.programId`), and the verifier program itself.
 *
 * Deduplicates and returns a fresh array (safe to pass straight to `createSharedLookupTable`/
 * `extendSharedLookupTable`, which do not require uniqueness themselves but there is no reason to
 * waste ALT slots on repeats).
 */
export function staticAccountsFor(accounts: {
  readonly pool?: PublicKey;
  readonly asset?: PublicKey;
  readonly mint?: PublicKey;
  readonly vault?: PublicKey;
  readonly depositorTokenAccount?: PublicKey;
  readonly destinationTokenAccount?: PublicKey;
  readonly nullifier?: PublicKey;
  readonly nullifierA?: PublicKey;
  readonly nullifierB?: PublicKey;
  readonly tokenProgram?: PublicKey;
  readonly associatedTokenProgram?: PublicKey;
  readonly systemProgram?: PublicKey;
  readonly verifierProgram?: PublicKey;
}): PublicKey[] {
  const seen = new Map<string, PublicKey>();
  for (const key of Object.values(accounts)) {
    if (key) seen.set(key.toBase58(), key);
  }
  return [...seen.values()];
}
