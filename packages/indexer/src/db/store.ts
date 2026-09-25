import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export interface NoteRow {
  leafIndex: number;
  leaf: string;
  ephPubX: string;
  tag: string | null;
  cekWrap: string | null;
  ciphertext: string[]; // 7 hex strings
  root: string;
  slot: number;
}

export interface RootRow {
  cursor: number;
  root: string;
  nextLeafIndex: number;
  slot: number;
}

export interface ComplianceKeyRow {
  version: number;
  x: string;
  y: string;
  fromSlot: number;
}

export interface CursorState {
  lastSignature: string | null;
  lastSlot: number;
}

const CURSOR_ID = "singleton";
const ROOT_RING_SIZE = 256;

/** Thin typed wrapper over the indexer's SQLite store. Opens `:memory:` when no path given. */
export class IndexerStore {
  private readonly db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    if (path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  insertNote(note: NoteRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notes
          (leaf_index, leaf, eph_pub_x, tag, cek_wrap, ciphertext, root, slot)
         VALUES (@leafIndex, @leaf, @ephPubX, @tag, @cekWrap, @ciphertext, @root, @slot)`,
      )
      .run({
        leafIndex: note.leafIndex,
        leaf: note.leaf,
        ephPubX: note.ephPubX,
        tag: note.tag,
        cekWrap: note.cekWrap,
        ciphertext: JSON.stringify(note.ciphertext),
        root: note.root,
        slot: note.slot,
      });
  }

  getNotesFrom(fromLeafIndex: number): NoteRow[] {
    const rows = this.db
      .prepare(
        `SELECT leaf_index, leaf, eph_pub_x, tag, cek_wrap, ciphertext, root, slot
         FROM notes WHERE leaf_index >= ? ORDER BY leaf_index ASC`,
      )
      .all(fromLeafIndex) as Array<{
      leaf_index: number;
      leaf: string;
      eph_pub_x: string;
      tag: string | null;
      cek_wrap: string | null;
      ciphertext: string;
      root: string;
      slot: number;
    }>;
    return rows.map((r) => ({
      leafIndex: r.leaf_index,
      leaf: r.leaf,
      ephPubX: r.eph_pub_x,
      tag: r.tag,
      cekWrap: r.cek_wrap,
      ciphertext: JSON.parse(r.ciphertext) as string[],
      root: r.root,
      slot: r.slot,
    }));
  }

  insertNullifier(nullifier: string, slot: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO nullifiers (nullifier, slot) VALUES (?, ?)`)
      .run(nullifier, slot);
  }

  isNullifierSpent(nullifier: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM nullifiers WHERE nullifier = ?`)
      .get(nullifier);
    return row !== undefined;
  }

  /**
   * slice-2 F-5: every spent nullifier since `slot` (inclusive), for clients to check membership
   * of THEIR OWN notes locally instead of one `GET /nullifiers/:hex` round trip per unspent note
   * (which lets the indexer operator learn a wallet's exact note set before it is even spent, and
   * link it to the later spend once the same nullifier is queried again). The set of spent
   * nullifiers is public on-chain anyway, so returning them in bulk is not a new information leak.
   */
  getNullifiersFrom(slot: number): string[] {
    const rows = this.db
      .prepare(`SELECT nullifier FROM nullifiers WHERE slot >= ? ORDER BY slot ASC`)
      .all(slot) as { nullifier: string }[];
    return rows.map((r) => r.nullifier);
  }

  /** Pushes a new root into the 256-slot ring buffer, evicting the oldest entry once full. */
  pushRoot(root: string, nextLeafIndex: number, slot: number): void {
    const countRow = this.db.prepare(`SELECT COUNT(*) as c FROM roots`).get() as {
      c: number;
    };
    const maxCursorRow = this.db
      .prepare(`SELECT MAX(cursor) as m FROM roots`)
      .get() as { m: number | null };
    const nextCursor =
      countRow.c === 0
        ? 0
        : ((maxCursorRow.m ?? -1) + 1) % ROOT_RING_SIZE;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO roots (cursor, root, next_leaf_index, slot) VALUES (?, ?, ?, ?)`,
      )
      .run(nextCursor, root, nextLeafIndex, slot);
  }

  getLatestRoot(): RootRow | undefined {
    // `rowid DESC` breaks ties on `slot` (e.g. two inserts landing in the same slot, or the
    // `SolanaChainSource.onLogs` slot-0 bug this was fixed alongside) by true insertion order --
    // `INSERT OR REPLACE` always allocates a fresh (higher) rowid, even for a ring-buffer cursor
    // that wraps and replaces an old row, so this stays correct across the full 256-entry ring.
    const row = this.db
      .prepare(
        `SELECT cursor, root, next_leaf_index, slot FROM roots ORDER BY slot DESC, rowid DESC LIMIT 1`,
      )
      .get() as
      | { cursor: number; root: string; next_leaf_index: number; slot: number }
      | undefined;
    if (!row) return undefined;
    return {
      cursor: row.cursor,
      root: row.root,
      nextLeafIndex: row.next_leaf_index,
      slot: row.slot,
    };
  }

  /** All 256 ring-buffer slots, oldest-first by cursor; empty slots are absent (caller pads). */
  listRoots(): RootRow[] {
    const rows = this.db
      .prepare(`SELECT cursor, root, next_leaf_index, slot FROM roots ORDER BY cursor ASC`)
      .all() as Array<{
      cursor: number;
      root: string;
      next_leaf_index: number;
      slot: number;
    }>;
    return rows.map((r) => ({
      cursor: r.cursor,
      root: r.root,
      nextLeafIndex: r.next_leaf_index,
      slot: r.slot,
    }));
  }

  insertComplianceKey(row: ComplianceKeyRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO compliance_keys (version, x, y, from_slot) VALUES (?, ?, ?, ?)`,
      )
      .run(row.version, row.x, row.y, row.fromSlot);
  }

  listComplianceKeys(): ComplianceKeyRow[] {
    const rows = this.db
      .prepare(`SELECT version, x, y, from_slot FROM compliance_keys ORDER BY version ASC`)
      .all() as Array<{ version: number; x: string; y: string; from_slot: number }>;
    return rows.map((r) => ({ version: r.version, x: r.x, y: r.y, fromSlot: r.from_slot }));
  }

  getCursor(): CursorState {
    const row = this.db
      .prepare(`SELECT last_signature, last_slot FROM cursor WHERE id = ?`)
      .get(CURSOR_ID) as { last_signature: string | null; last_slot: number } | undefined;
    if (!row) return { lastSignature: null, lastSlot: 0 };
    return { lastSignature: row.last_signature, lastSlot: row.last_slot };
  }

  setCursor(state: CursorState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cursor (id, last_signature, last_slot) VALUES (?, ?, ?)`,
      )
      .run(CURSOR_ID, state.lastSignature, state.lastSlot);
  }
}
