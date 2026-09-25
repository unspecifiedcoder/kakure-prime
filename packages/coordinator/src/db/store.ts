import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import type { Envelope } from "../schema.js";

export const TTL_MS = 24 * 60 * 60 * 1000;

export class SequenceConflictError extends Error {
  constructor(sessionId: string, seq: number) {
    super(`seq ${seq} already exists (or is not the next seq) for session ${sessionId}`);
  }
}

/** Thin typed wrapper over the coordinator's SQLite store. Opens `:memory:` when no path given. */
export class MessageStore {
  private readonly db: Database.Database;

  constructor(
    path: string = ":memory:",
    private readonly now: () => number = () => Date.now(),
  ) {
    this.db = new Database(path);
    if (path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /** Appends an envelope; throws `SequenceConflictError` if `seq` isn't strictly the next one. */
  append(envelope: Envelope): void {
    const expectedSeq = this.nextSeq(envelope.session_id);
    if (envelope.seq !== expectedSeq) {
      throw new SequenceConflictError(envelope.session_id, envelope.seq);
    }
    this.db
      .prepare(
        `INSERT INTO messages (session_id, seq, kind, ciphertext, created_at)
         VALUES (@session_id, @seq, @kind, @ciphertext, @created_at)`,
      )
      .run({
        session_id: envelope.session_id,
        seq: envelope.seq,
        kind: envelope.kind,
        ciphertext: envelope.ciphertext,
        created_at: this.now(),
      });
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) as m FROM messages WHERE session_id = ?`)
      .get(sessionId) as { m: number | null };
    return row.m === null ? 0 : row.m + 1;
  }

  /** All envelopes for a session with `seq > since` (or all, if `since` omitted), seq-ascending. */
  since(sessionId: string, since?: number): Envelope[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, seq, kind, ciphertext FROM messages
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionId, since ?? -1) as Array<{
      session_id: string;
      seq: number;
      kind: string;
      ciphertext: string;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      seq: r.seq,
      kind: r.kind as Envelope["kind"],
      ciphertext: r.ciphertext,
    }));
  }

  /**
   * Deletes every message of a session, but ONLY for sessions whose NEWEST message is older than
   * the 24h TTL. Returns the number of rows removed.
   *
   * slice-2 F-8: sweeping by per-MESSAGE age (the old `DELETE ... WHERE created_at < cutoff`)
   * could delete a session's early messages while leaving its later ones. `seq` is a single
   * counter per session (`nextSeq` = `MAX(seq) + 1`), so a partial sweep does not reset it -- but
   * a session whose EVERY message aged out gets fully cleared, and its next `append()` restarts
   * numbering at `seq = 0`. A client with a cached `nextSeqGuess`/`since` cursor from before the
   * sweep then polls with `since = <old high seq>`, which every message of the FRESH, restarted
   * stream (seq 0, 1, 2, ...) fails to satisfy -- silently missing the entire restarted stream
   * forever, with no error at all. Sweeping whole sessions atomically (only once NO message in it
   * is still fresh) means a session either survives intact (old cursors stay valid) or is wholly
   * gone (a client sees "no such session" rather than a silently-restarted one).
   */
  sweepExpired(): number {
    const cutoff = this.now() - TTL_MS;
    const result = this.db
      .prepare(
        `DELETE FROM messages WHERE session_id IN (
           SELECT session_id FROM messages GROUP BY session_id HAVING MAX(created_at) < ?
         )`,
      )
      .run(cutoff);
    return result.changes;
  }
}
