# Workstream E — indexer + coordinator services

Scope: `packages/indexer/` (`@kakure/indexer`), `packages/coordinator/` (`@kakure/coordinator`),
justfile lines under `# --- workstream E: services ---`, this plan file. No other directories touched.

Frozen interfaces binding this work: I-4 (events), I-5 (tree), I-7 (coordinator envelope + HTTP/WS),
I-8 (indexer HTTP API). Local types mirror these; no import-time dependency on `kakure_pool` or
`@kakure/sdk` (both being built in parallel by B/C). TODO comments mark the swap points.

Each task below: write a failing test, run it (red), implement, run again (green), commit.

## Indexer (`packages/indexer`)

1. Package scaffold: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, empty
   `src/index.ts`. Trivial smoke test. Commit: `chore(indexer): scaffold package`.
2. SQLite schema module (`src/db/schema.ts`, `src/db/store.ts` over `better-sqlite3`): tables
   `notes(leaf_index INTEGER PK, leaf, eph_pub_x, tag, cek_wrap, ciphertext_json, root, slot)`,
   `nullifiers(nullifier PK, slot)`, `roots(cursor INTEGER PK, root, next_leaf_index)`,
   `compliance_keys(version INTEGER PK, x, y, from_slot)`, `cursor(id PK, last_signature, last_slot)`.
   Test: open in-memory db, migrate, insert/read round trip each table. Commit.
3. Poseidon v1 (circom params) hash helper (`src/tree/poseidonV1.ts`) via `poseidon-lite`
   (`poseidon2`/`poseidon3`), big-endian 32-byte Field <-> bigint helpers. Test: hash matches a
   known circomlibjs-equivalent vector (hand-computed / cross-checked with `poseidon-lite` directly
   since that IS the circom-compatible implementation used project-wide per I-5).
4. `LeanIMT` mirror (`src/tree/leanImt.ts`): depth 32, `node = poseidonV1.hash3([left,right,level])`,
   zero-sibling pass-through, frontier insert, stores every level (needed to serve sibling paths),
   `getRoot()`, `getPath(leafIndex)`. TODO comment: swap to `@kakure/sdk`'s LeanIMT at integration.
   Tests: sequential inserts produce expected roots/paths per hand-built vectors (depth-4 toy tree
   for speed, plus one depth-32 root sanity check with all-zero unfilled levels).
5. Anchor IDL-driven event decoder (`src/events/decode.ts` + `src/events/idl.ts` types): given IDL
   json (path from config) and raw self-CPI instruction data bytes, verify the 8-byte `e445a52e51cb9a1d`
   emit_cpi prefix, then match the following 8-byte event discriminator (`sha256("event:<Name>")[0..8]`)
   against the IDL's declared events, borsh-decode the remaining bytes per the IDL's field layout for
   `NoteInserted`/`NullifierSpent`/`ComplianceKeyRotated` (I-4). Fixture tests: hand-construct bytes for
   each event and assert decoded shape; assert malformed/short data and unknown discriminator are rejected.
6. Chain connection abstraction (`src/chain/types.ts` — `ChainSource` interface: `getSignaturesForAddress`,
   `getTransaction`, `onLogs(programId, cb)`) + a thin `@solana/web3.js` `Connection` adapter
   (`src/chain/solanaSource.ts`). Tests inject a fake `ChainSource`.
7. Ingestion loop (`src/ingest/ingest.ts`): backfill via `getSignaturesForAddress` (oldest→newest,
   persisting cursor), decode each tx's self-CPI events, feed `NoteInserted` into the LeanIMT mirror
   and `notes`/`roots` tables, `NullifierSpent` into `nullifiers`, `ComplianceKeyRotated` into
   `compliance_keys`; then live tail via `onLogs`. Tests with a fake `ChainSource` and fixture txs:
   backfill populates db+tree correctly; live event appends further; idempotent re-run (cursor) does
   not double-insert.
8. HTTP API (`src/api/server.ts`, Fastify) implementing I-8 exactly:
   `GET /root`, `GET /path/:leaf_index`, `GET /notes?from=`, `GET /nullifiers/:hex`, `GET /compliance`.
   Tests hit the routes with `fastify.inject` against a seeded db/tree.
9. `bin/kakure-indexer` (`src/cli.ts`) with `--port --rpc --program-id --idl --db` flags; `README.md`.
10. `pnpm build && pnpm test` green; commit.

## Coordinator (`packages/coordinator`)

1. Package scaffold like indexer. Commit.
2. I-7 `Envelope` zod schema (`src/schema.ts`): `session_id` hex32, `seq` non-negative int, `kind`
   enum, `ciphertext` base64. Tests: valid passes, each invalid field rejected.
3. SQLite store (`src/db/store.ts`): `messages(session_id, seq, kind, ciphertext, created_at)`,
   append (seq must be next for session or reject), read `since seq`, TTL sweep deleting rows older
   than 24h. Tests for append/read/order/TTL sweep.
4. Privacy-safe logger (`src/logger.ts`): two disjoint log functions — `logSession(event, session_id)`
   (no timestamp field ever attached) and `logTiming(event, durationMs)` (no session id field ever
   attached) — structured so the type signatures make it impossible to pass both into one call/line.
   Test: call both across a simulated request flow, capture output, assert no single line matches a
   hex32 AND an ISO-timestamp/epoch-ms pattern.
5. HTTP + WS server (`src/api/server.ts`, Fastify + `@fastify/websocket` or raw `ws`):
   `POST /sessions/:id/messages` (validate envelope, append, broadcast to WS subscribers),
   `GET /sessions/:id/messages?since=seq` (long-poll up to 25s: return immediately if data present,
   else wait for a new append or timeout then return `[]`), `WS /sessions/:id` (push new envelopes).
   Tests: post+get round trip, long-poll resolves early on append, long-poll times out to `[]`,
   WS receives pushed envelope.
6. TTL sweep scheduled task wiring + test (fake clock / directly invoke sweep).
7. `bin/kakure-coordinator` (`src/cli.ts`) with `--port --db` flags; `README.md`.
8. `pnpm build && pnpm test` green; commit.

## justfile

Add `test-indexer`, `test-coordinator`, `build-services` targets under
`# --- workstream E: services ---`. Commit.

## Final report

Confirm I-7/I-8 shapes byte-for-byte (or flag deviation), list endpoints, test commands + pass/fail,
run instructions, and notes for D (CLI) / F (e2e) consumers.
