import type { MessageStore } from "./db/store.js";
import type { Logger } from "./logger.js";

export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

/** Starts a periodic TTL sweep; returns a stop function. Logs via `logTiming` only (no session id). */
export function startTtlSweep(
  store: MessageStore,
  logger: Logger,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    const removed = store.sweepExpired();
    logger.logTiming("sweep.rows_removed", removed);
  }, intervalMs);
  return () => clearInterval(timer);
}
