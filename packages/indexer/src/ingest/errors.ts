/**
 * Thrown when a transaction's logs were truncated by the Agave runtime's log-buffer cap
 * (`log_messages_bytes_limit`, default 10 000 bytes) before the indexer finished scanning them for
 * `kakure_pool` events (slice-2 F-4). A truncated log silently drops every later line -- including
 * the `Program data:` lines events live in AND the `Program … success` bracket line `logScope.ts`
 * relies on -- so there is no way to tell, from the logs alone, whether zero events were emitted or
 * ten were and nine got cut. `kakure_pool` has no signer gate on any money path (spec §6), so this
 * is attacker-triggerable: CPI into the pool from a wrapper program that first burns ~10KB of log
 * budget on cheap `msg!` output, and the indexer's mirror silently falls one leaf behind forever.
 *
 * By design this is NOT recoverable by the ingestor itself and must never be swallowed: the
 * indexer's mirror is either exactly right or it must stop serving reads. See `ingest.ts`'s
 * `processSignature` (throws this before advancing the cursor) and `startLiveTail` (catches it
 * specifically to unsubscribe and alert, rather than logging and continuing like other per-tx
 * errors).
 */
export class LogTruncationError extends Error {
  readonly signature: string;
  readonly slot: number;

  constructor(signature: string, slot: number) {
    super(
      `kakure indexer HALT: transaction ${signature} (slot ${slot}) has a truncated log ` +
        `("Log truncated" runtime line present) -- events after the cut point are UNRECOVERABLE ` +
        `from logs and the indexer's mirror may already be missing a leaf. Ingestion has stopped ` +
        `rather than silently advancing the cursor past it. This requires operator intervention ` +
        `(reconcile against on-chain state, e.g. Pool.next_leaf_index, before resuming).`,
    );
    this.name = "LogTruncationError";
    this.signature = signature;
    this.slot = slot;
  }
}

/** True iff the Agave runtime appended its "logs truncated" marker to this transaction's logs. */
export function logsWereTruncated(logMessages: readonly string[]): boolean {
  return logMessages.some((l) => l === "Log truncated" || l.startsWith("Log truncated"));
}
