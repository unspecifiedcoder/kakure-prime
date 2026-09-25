/**
 * @kakure/coordinator SQLite schema. Stores ciphertext only — the coordinator learns session ids,
 * message sizes and timing, never plaintext (spec §5 "Coordinator privacy contract").
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL, -- epoch ms; used only for the TTL sweep, never logged alongside session_id
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
`;
