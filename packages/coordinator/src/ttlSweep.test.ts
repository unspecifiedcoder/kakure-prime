import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore, TTL_MS } from "./db/store.js";
import { createLogger } from "./logger.js";
import { startTtlSweep } from "./ttlSweep.js";

describe("startTtlSweep", () => {
  let clock: number;
  let store: MessageStore;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    store = new MessageStore(":memory:", () => clock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("periodically removes expired rows and logs the count via logTiming only", () => {
    store.append({ session_id: "a".repeat(64), seq: 0, kind: "dkg1", ciphertext: "aGk=" });
    clock += TTL_MS + 1;

    const lines: string[] = [];
    const stop = startTtlSweep(store, createLogger((l) => lines.push(l)), 1000);

    vi.advanceTimersByTime(1000);
    stop();

    expect(store.since("a".repeat(64))).toHaveLength(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed["event"]).toBe("sweep.rows_removed");
    expect(parsed["value"]).toBe(1);
    expect(parsed["session_id"]).toBeUndefined();
  });

  it("stop() halts further sweeps", () => {
    const lines: string[] = [];
    const stop = startTtlSweep(store, createLogger((l) => lines.push(l)), 1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(lines).toHaveLength(0);
  });
});
