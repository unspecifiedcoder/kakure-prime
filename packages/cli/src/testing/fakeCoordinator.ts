/**
 * In-memory server implementing the exact I-7 HTTP contract (`coordinator/README.md`), so CLI
 * tests exercise the real `CoordinatorClient` over real HTTP without needing the actual
 * `@kakure/coordinator` package (which owns SQLite/TTL/logging concerns out of scope here).
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Envelope } from "../coordinatorClient.js";

export class FakeCoordinator {
  private app: FastifyInstance;
  private sessions = new Map<string, Envelope[]>();
  private url = "";

  constructor(private readonly longPollTimeoutMs = 200) {
    this.app = Fastify({ logger: false });
    this.app.post<{ Params: { id: string }; Body: Envelope }>(
      "/sessions/:id/messages",
      async (req, reply) => {
        const envelope = req.body;
        if (!envelope || envelope.session_id !== req.params.id) {
          return reply.status(400).send({ error: "bad envelope" });
        }
        const list = this.sessions.get(req.params.id) ?? [];
        const expected = list.length === 0 ? 0 : Math.max(...list.map((e) => e.seq)) + 1;
        if (envelope.seq !== expected && list.some((e) => e.seq === envelope.seq)) {
          return reply.status(409).send({ error: "sequence conflict" });
        }
        list.push(envelope);
        this.sessions.set(req.params.id, list);
        return reply.status(201).send({ ok: true });
      },
    );

    this.app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
      "/sessions/:id/messages",
      async (req) => {
        const since = req.query.since !== undefined ? Number(req.query.since) : -1;
        const list = this.sessions.get(req.params.id) ?? [];
        const matching = list.filter((e) => e.seq > since);
        if (matching.length > 0) return matching;
        await new Promise((r) => setTimeout(r, this.longPollTimeoutMs));
        const retry = (this.sessions.get(req.params.id) ?? []).filter((e) => e.seq > since);
        return retry;
      },
    );
  }

  async start(): Promise<string> {
    await this.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = this.app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("FakeCoordinator: no address");
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  /** Directly append an envelope to a session's log, bypassing the real client -- used to
   *  simulate an attacker (or a misbehaving member) posting a crafted envelope directly to the
   *  coordinator's HTTP API, which any session-id holder can do (I-7 has no per-member auth). */
  inject(sessionId: string, kind: Envelope["kind"], ciphertext: string): void {
    const list = this.sessions.get(sessionId) ?? [];
    const seq = list.length === 0 ? 0 : Math.max(...list.map((e) => e.seq)) + 1;
    list.push({ session_id: sessionId, seq, kind, ciphertext });
    this.sessions.set(sessionId, list);
  }

  /** Every envelope posted to a session so far, in `seq` order. */
  envelopes(sessionId: string): Envelope[] {
    return [...(this.sessions.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}
