/**
 * In-memory server implementing the exact I-8 HTTP contract (`indexer/README.md`), for CLI tests
 * (`balance`, `deposit`) that need a `ChainView`/notes source without a live indexer.
 */
import Fastify, { type FastifyInstance } from "fastify";

export interface FakeNoteInserted {
  leaf_index: number;
  leaf: string;
  eph_pub_x: string;
  tag: string | null;
  cek_wrap: string | null;
  ciphertext: string[];
  root: string;
}

const ZERO32 = "0x" + "0".repeat(64);

export class FakeIndexer {
  private app: FastifyInstance;
  private notes: FakeNoteInserted[] = [];
  private roots: string[] = [ZERO32];
  private compliance = [{ version: 0, x: ZERO32, y: ZERO32, from_slot: 0 }];
  private nullifiers = new Set<string>();
  /** slice-2 F-5 test hook: every `hex` requested via the per-note `/nullifiers/:hex` endpoint. */
  readonly perNoteNullifierFetches: string[] = [];

  constructor() {
    this.app = Fastify({ logger: false });

    this.app.get("/root", async () => ({
      root: this.roots[this.roots.length - 1],
      next_leaf_index: this.notes.length,
      roots: this.padRoots(),
    }));

    this.app.get<{ Params: { leaf_index: string } }>("/path/:leaf_index", async (req, reply) => {
      const idx = Number(req.params.leaf_index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.notes.length) {
        return reply.status(404).send({ error: "leaf_index out of bounds" });
      }
      return { siblings: Array(32).fill(ZERO32) };
    });

    this.app.get<{ Querystring: { from?: string } }>("/notes", async (req) => {
      const from = req.query.from !== undefined ? Number(req.query.from) : 0;
      return this.notes.filter((n) => n.leaf_index >= from);
    });

    this.app.get<{ Querystring: { from_slot?: string } }>("/nullifiers", async () => ({
      nullifiers: [...this.nullifiers],
    }));

    this.app.get<{ Params: { hex: string } }>("/nullifiers/:hex", async (req) => {
      this.perNoteNullifierFetches.push(req.params.hex);
      return { spent: this.nullifiers.has(req.params.hex.toLowerCase()) };
    });

    this.app.get("/compliance", async () => this.compliance);
  }

  private padRoots(): string[] {
    const out = new Array(256).fill(ZERO32);
    for (let i = 0; i < this.roots.length && i < 256; i++) out[i] = this.roots[i];
    return out;
  }

  insertNote(note: Omit<FakeNoteInserted, "leaf_index">, newRoot: string): FakeNoteInserted {
    const inserted: FakeNoteInserted = { ...note, leaf_index: this.notes.length };
    this.notes.push(inserted);
    this.roots.push(newRoot);
    return inserted;
  }

  markSpent(nullifierHex: string): void {
    this.nullifiers.add(nullifierHex.toLowerCase());
  }

  async start(): Promise<string> {
    await this.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = this.app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("FakeIndexer: no address");
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
