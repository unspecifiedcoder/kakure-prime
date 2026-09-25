/**
 * @kakure/indexer SQLite schema.
 *
 * Mirrors the on-chain state the indexer must serve per I-8:
 *   notes            -- one row per NoteInserted event (I-4), keyed by leaf_index
 *   nullifiers       -- one row per NullifierSpent event (I-4)
 *   roots            -- ring-buffer snapshot of the LeanIMT mirror's root after each insert
 *   compliance_keys  -- history of ComplianceKeyRotated events (I-4)
 *   cursor           -- ingestion progress, single row (id = 'singleton')
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  leaf_index    INTEGER PRIMARY KEY,
  leaf          TEXT NOT NULL,
  eph_pub_x     TEXT NOT NULL,
  tag           TEXT,
  cek_wrap      TEXT,
  ciphertext    TEXT NOT NULL, -- JSON array of 7 hex strings
  root          TEXT NOT NULL, -- tree root immediately after this insert
  slot          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nullifiers (
  nullifier TEXT PRIMARY KEY,
  slot      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
  cursor          INTEGER PRIMARY KEY, -- position in the 256-slot ring buffer
  root            TEXT NOT NULL,
  next_leaf_index INTEGER NOT NULL,
  slot            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS compliance_keys (
  version   INTEGER PRIMARY KEY,
  x         TEXT NOT NULL,
  y         TEXT NOT NULL,
  from_slot INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cursor (
  id             TEXT PRIMARY KEY,
  last_signature TEXT,
  last_slot      INTEGER NOT NULL DEFAULT 0
);
`;
