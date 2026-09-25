/** One `getSignaturesForAddress`-style result entry. */
export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
}

/**
 * A transaction's program log lines, in emission order.
 *
 * `kakure_pool` is a native `solana-program` crate (no Anchor), so events are NOT `emit_cpi!`
 * self-CPI instructions -- they are `sol_log_data` program-log lines (see
 * `programs/kakure_pool/src/events.rs`), which land in `meta.logMessages`, not in any
 * instruction's data. Hence this replaces the old `instructions: RawInstruction[]`.
 */
export interface RawTransaction {
  signature: string;
  slot: number;
  /** `null` when the transaction failed on-chain (its events must not be ingested). */
  err: unknown | null;
  logMessages: string[];
}

/**
 * Abstraction over the Solana JSON-RPC surface the ingestion loop needs, so tests can inject a
 * fake implementation instead of talking to a real cluster. `@solana/web3.js`'s `Connection` is
 * wrapped behind this in `solanaSource.ts`.
 */
export interface ChainSource {
  getSignaturesForAddress(
    address: string,
    opts?: { before?: string; until?: string; limit?: number },
  ): Promise<SignatureInfo[]>;

  getTransaction(signature: string): Promise<RawTransaction | null>;

  /** Subscribe to live logs mentioning `address`; returns an unsubscribe function. */
  onLogs(address: string, callback: (info: SignatureInfo) => void): () => void;
}
