# @kakure/indexer

Watches `kakure_pool` for `NoteInserted` / `NullifierSpent` / `ComplianceKeyRotated` events
(spec §4 / plan I-4), maintains a LeanIMT mirror of the on-chain commitment tree (I-5), and serves
the indexer HTTP API (I-8) that the SDK/CLI/e2e consume.

## Run

```sh
pnpm --filter @kakure/indexer build
node dist/cli.js \
  --port 8787 \
  --rpc http://127.0.0.1:8899 \
  --program-id <kakure_pool program id> \
  --idl ./kakure_pool.json \
  --db ./kakure-indexer.sqlite
```

Flags:

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--port` | no | `8787` | HTTP API port |
| `--rpc` | no | `http://127.0.0.1:8899` | Solana JSON-RPC + websocket endpoint |
| `--program-id` | yes | — | `kakure_pool` program id (base58) |
| `--idl` | yes | — | path to the Anchor IDL JSON used to decode `emit_cpi!` events |
| `--db` | no | `./kakure-indexer.sqlite` | SQLite file (use `:memory:` for tests/dev) |

## API (I-8)

- `GET /root` → `{ root: string, next_leaf_index: number, roots: string[256] }`
- `GET /path/:leaf_index` → `{ siblings: string[32] }` (404 if out of bounds)
- `GET /notes?from=<leaf_index>` → `NoteInserted[]` (each: `leaf_index, leaf, eph_pub_x, tag, cek_wrap, ciphertext, root`)
- `GET /nullifiers/:hex` → `{ spent: boolean }`
- `GET /compliance` → `[{ version, x, y, from_slot }]`

All hex fields are `0x`-prefixed, big-endian, 32-byte field elements (except `ciphertext`, an array
of 7 such strings).

## Design notes / integration TODOs

- The LeanIMT mirror (`src/tree/leanImt.ts`) and Poseidon v1 hash (`src/tree/poseidonV1.ts`,
  circom parameters via `poseidon-lite`) are local implementations per I-5. **TODO(integration):**
  swap for `@kakure/sdk`'s LeanIMT once workstream C publishes it, cross-checking against
  `circuits/kat/lean_imt_poseidon_v1.json` (workstream A).
- Event decoding (`src/events/decode.ts`) reads an Anchor IDL from `--idl` and decodes `emit_cpi!`
  self-CPI instruction data generically from its `events`/`types` sections. A local default IDL
  (`src/events/idl.ts`, `DEFAULT_KAKURE_POOL_IDL`) mirrors I-4 for tests; point `--idl` at the real
  `kakure_pool` IDL (workstream B) once published — no code change needed if its event structs
  match I-4's field names/order.
- The chain connection is abstracted behind `ChainSource` (`src/chain/types.ts`) so ingestion logic
  is testable without a live cluster; `SolanaChainSource` (`src/chain/solanaSource.ts`) is the real
  `@solana/web3.js` adapter.
- On restart, call `Ingestor.hydrateTree()` before `backfill()`/`startLiveTail()` to rebuild the
  in-memory tree mirror from persisted notes (the tree itself is not persisted, only note rows).

## Test

```sh
pnpm --filter @kakure/indexer test
```
