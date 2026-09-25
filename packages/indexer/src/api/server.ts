import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { IndexerStore } from "../db/store.js";
import type { LeanIMT } from "../tree/leanImt.js";
import { fieldToHex } from "../tree/poseidonV1.js";
import type { Ingestor } from "../ingest/ingest.js";

export interface IndexerApiOptions {
  /** Allowed browser origin(s) for CORS. Default: see the register call below. */
  readonly corsOrigin?: string | boolean | RegExp | string[];
  store: IndexerStore;
  tree: LeanIMT;
  /**
   * Optional (backward compatible: omitting it keeps pre-F-4 behavior). When given, `/root` and
   * `/path/:leaf_index` -- the two endpoints that serve the LeanIMT mirror's own leaf indices, as
   * opposed to reading persisted event rows straight through -- return 503 once
   * `ingestor.halted` is set (slice-2 F-4: a truncated log means the mirror may be silently one
   * leaf short, and every witness/path built from it would fold to a root the pool never wrote).
   */
  ingestor?: Ingestor;
}

const ROOT_RING_SIZE = 256;

/**
 * Builds the indexer's HTTP API exactly per I-8:
 *   GET /root                 -> { root, next_leaf_index, roots: string[256], root_cursor }
 *   GET /path/:leaf_index     -> { siblings: string[32] }
 *   GET /notes?from=<n>       -> NoteInserted[]
 *   GET /nullifiers/:hex      -> { spent: bool }
 *   GET /compliance           -> [{version, x, y, from_slot}]
 *
 * `root_cursor` (workstream G, additive -- I-8 stays backward compatible: every field present
 * before is still present, unchanged): the on-chain `Pool::root_cursor()`'s value, i.e. the NEXT
 * ring-buffer slot `push_root` will write to (== one past the slot the latest root was written at,
 * wrapping mod 256). A client resolving a `root_index` for a spend instruction (workstream G's
 * `PoolInstruction::{Transfer,...}` all now take one instead of a 32-byte root -- see
 * `programs/kakure_pool/src/instruction.rs`'s module docs) can search `roots` starting at
 * `root_cursor - 1` (the freshest entry) without needing a separate `/root_cursor` round trip or
 * decoding the raw `Pool` account itself (`@kakure/sdk/solana`'s `rootIndexFor` does exactly this
 * search, but against a `PoolAccount` from `decodePool`, not this HTTP shape).
 */
export function buildIndexerApi(opts: IndexerApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  // CORS: the indexer is a read-only public API; origin is configurable (default any) for browser clients.
  void app.register(cors, { origin: opts.corsOrigin ?? true, methods: ["GET","POST","OPTIONS"] });
  const { store, tree, ingestor } = opts;

  /** slice-2 F-4: refuse to serve mirror-derived reads once a truncated log has been observed. */
  function haltedReply(reply: { status: (code: number) => { send: (body: unknown) => unknown } }): unknown {
    return reply.status(503).send({
      error: "indexer halted: a truncated transaction log was observed and the leaf mirror is " +
        "no longer trusted; operator intervention is required before this endpoint can be served again",
    });
  }

  app.get("/root", async (_req, reply) => {
    if (ingestor?.halted) return haltedReply(reply);
    const latest = store.getLatestRoot();
    const rows = store.listRoots();
    const roots: string[] = new Array(ROOT_RING_SIZE).fill(
      "0x" + "0".repeat(64),
    );
    for (const row of rows) {
      if (row.cursor >= 0 && row.cursor < ROOT_RING_SIZE) {
        roots[row.cursor] = row.root;
      }
    }
    // Mirrors `Pool::push_root`: the on-chain cursor is advanced to `(written_slot + 1) %
    // ROOT_RING_SIZE` immediately after writing a root at `written_slot`, so it always points at
    // the NEXT slot to be written, not the most recently written one.
    const rootCursor = latest ? (latest.cursor + 1) % ROOT_RING_SIZE : 0;
    return {
      root: latest?.root ?? fieldToHex(tree.getRoot()),
      next_leaf_index: latest?.nextLeafIndex ?? tree.nextLeafIndex,
      roots,
      root_cursor: rootCursor,
    };
  });

  app.get<{ Params: { leaf_index: string } }>("/path/:leaf_index", async (req, reply) => {
    if (ingestor?.halted) return haltedReply(reply);
    const leafIndex = Number(req.params.leaf_index);
    if (!Number.isInteger(leafIndex) || leafIndex < 0) {
      return reply.status(400).send({ error: "invalid leaf_index" });
    }
    try {
      const siblings = tree.getPath(leafIndex).map((s) => fieldToHex(s));
      return { siblings };
    } catch {
      return reply.status(404).send({ error: "leaf_index out of bounds" });
    }
  });

  app.get<{ Querystring: { from?: string } }>("/notes", async (req) => {
    const from = req.query.from !== undefined ? Number(req.query.from) : 0;
    const notes = store.getNotesFrom(Number.isFinite(from) ? from : 0);
    return notes.map((n) => ({
      leaf_index: n.leafIndex,
      leaf: n.leaf,
      eph_pub_x: n.ephPubX,
      tag: n.tag,
      cek_wrap: n.cekWrap,
      ciphertext: n.ciphertext,
      root: n.root,
    }));
  });

  // slice-2 F-5: bulk range query -- wallets should fetch every spent nullifier since a slot and
  // check membership locally (the set is public on-chain anyway), instead of one
  // `GET /nullifiers/:hex` round trip per unspent note, which lets the indexer operator learn a
  // wallet's exact note set before it is even spent. `/nullifiers/:hex` (below) is kept for
  // explorers/spot-checks.
  app.get<{ Querystring: { from_slot?: string } }>("/nullifiers", async (req, reply) => {
    const raw = req.query.from_slot;
    const fromSlot = raw !== undefined ? Number(raw) : 0;
    if (!Number.isFinite(fromSlot)) {
      return reply.status(400).send({ error: "invalid from_slot" });
    }
    return { nullifiers: store.getNullifiersFrom(fromSlot) };
  });

  app.get<{ Params: { hex: string } }>("/nullifiers/:hex", async (req) => {
    return { spent: store.isNullifierSpent(req.params.hex) };
  });

  app.get("/compliance", async () => {
    return store.listComplianceKeys().map((k) => ({
      version: k.version,
      x: k.x,
      y: k.y,
      from_slot: k.fromSlot,
    }));
  });

  return app;
}
