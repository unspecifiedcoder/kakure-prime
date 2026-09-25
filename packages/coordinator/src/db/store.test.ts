import { beforeEach, describe, expect, it } from "vitest";
import { MessageStore, SequenceConflictError, TTL_MS } from "./store.js";
import type { Envelope } from "../schema.js";

const sid = "a".repeat(64);

function envelope(seq: number, ciphertext = "aGk="): Envelope {
  return { session_id: sid, seq, kind: "dkg1", ciphertext };
}

describe("MessageStore", () => {
  let clock: number;
  let store: MessageStore;

  beforeEach(() => {
    clock = 1_000_000;
    store = new MessageStore(":memory:", () => clock);
  });

  it("appends and reads back in seq order", () => {
    store.append(envelope(0, "aGk="));
    store.append(envelope(1, "eW8="));
    expect(store.since(sid)).toEqual([
      { session_id: sid, seq: 0, kind: "dkg1", ciphertext: "aGk=" },
      { session_id: sid, seq: 1, kind: "dkg1", ciphertext: "eW8=" },
    ]);
  });

  it("since(sessionId, seq) returns only newer messages", () => {
    store.append(envelope(0));
    store.append(envelope(1));
    store.append(envelope(2));
    expect(store.since(sid, 1).map((e) => e.seq)).toEqual([2]);
  });

  it("rejects an out-of-order or duplicate seq", () => {
    store.append(envelope(0));
    expect(() => store.append(envelope(0))).toThrow(SequenceConflictError);
    expect(() => store.append(envelope(5))).toThrow(SequenceConflictError);
  });

  it("keeps separate sequence counters per session", () => {
    const otherSid = "b".repeat(64);
    store.append(envelope(0));
    store.append({ ...envelope(0), session_id: otherSid });
    expect(store.since(sid)).toHaveLength(1);
    expect(store.since(otherSid)).toHaveLength(1);
  });

  it("sweepExpired removes rows older than the 24h TTL", () => {
    store.append(envelope(0));
    clock += TTL_MS + 1;
    store.append({ ...envelope(0), session_id: "c".repeat(64) });
    const removed = store.sweepExpired();
    expect(removed).toBe(1);
    expect(store.since(sid)).toHaveLength(0);
    expect(store.since("c".repeat(64))).toHaveLength(1);
  });

  // slice-2 F-8: sweeping per-message could empty a session down to a subset while its `seq`
  // numbering stays intact, but the real risk is the OTHER direction -- if a session's EVERY
  // message ages out it gets wiped and its next append() restarts `seq` at 0, silently breaking
  // any client with a cursor from before the sweep. A session with even one fresh message must
  // keep ALL of its messages, old ones included -- proving the sweep is whole-session, not per-row.
  it("a session with one fresh message keeps its old ones too (whole-session sweep, not per-row)", () => {
    store.append(envelope(0)); // old: created at the original `clock`
    clock += TTL_MS + 1;
    store.append(envelope(1)); // fresh: created after the TTL window advanced
    const removed = store.sweepExpired();
    expect(removed).toBe(0);
    expect(store.since(sid).map((e) => e.seq)).toEqual([0, 1]);
  });
});
