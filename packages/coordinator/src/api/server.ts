import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import { EnvelopeSchema, type Envelope } from "../schema.js";
import { MessageStore, SequenceConflictError } from "../db/store.js";
import type { Logger } from "../logger.js";

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 25_000;

export interface CoordinatorApiOptions {
  /** Allowed browser origin(s) for CORS. Default: see the register call below. */
  readonly corsOrigin?: string | boolean | RegExp | string[];
  store: MessageStore;
  logger: Logger;
  /** Overridable for tests; production default is 25s per I-7. */
  longPollTimeoutMs?: number;
}

type SessionListener = (envelope: Envelope) => void;

export interface CoordinatorApi {
  app: FastifyInstance;
  /** Attaches the WS upgrade handler to `app.server`. Call once, before `app.listen`. */
  attachWebSocket(): void;
}

const SESSION_ID_PATH_RE = /^\/sessions\/([0-9a-fA-F]{64})$/;

/**
 * Builds the coordinator's I-7 API:
 *   POST /sessions/:id/messages          -- append an envelope
 *   GET  /sessions/:id/messages?since=n  -- long-poll (up to 25s) for envelopes with seq > n
 *   WS   /sessions/:id                   -- push newly appended envelopes
 *
 * Server stores/relays ciphertext only; never inspects or logs plaintext.
 */
export function buildCoordinatorApi(opts: CoordinatorApiOptions): CoordinatorApi {
  const { store, logger } = opts;
  const longPollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const listeners = new Map<string, Set<SessionListener>>();

  function subscribe(sessionId: string, fn: SessionListener): () => void {
    let set = listeners.get(sessionId);
    if (!set) {
      set = new Set();
      listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) listeners.delete(sessionId);
    };
  }

  function publish(envelope: Envelope): void {
    const set = listeners.get(envelope.session_id);
    if (!set) return;
    for (const fn of [...set]) fn(envelope);
  }

  // slice-2 F-8: Fastify's default `bodyLimit` is 1 MiB -- far above any legitimate envelope
  // (F-3 item 3 calls for capping `ciphertext` at ~64 KiB). Setting it here makes Fastify itself
  // reject an oversized body with 413 before the route handler (and the JSON parser) ever run.
  const MAX_ENVELOPE_BODY_BYTES = 70_000; // ~64 KiB ciphertext + JSON/base64 overhead
  const app = Fastify({ logger: false, bodyLimit: MAX_ENVELOPE_BODY_BYTES });

  // CORS: ciphertext-only relay; origin is configurable (default any) for browser signers.

  void app.register(cors, { origin: opts.corsOrigin ?? true, methods: ["GET","POST","OPTIONS"] });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/sessions/:id/messages",
    async (req, reply) => {
      const parsed = EnvelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid envelope" });
      }
      const envelope = parsed.data;
      if (envelope.session_id !== req.params.id) {
        return reply.status(400).send({ error: "session_id does not match URL" });
      }
      try {
        store.append(envelope);
      } catch (err) {
        if (err instanceof SequenceConflictError) {
          logger.logSession("session.sequence_conflict", envelope.session_id);
          return reply.status(409).send({ error: "sequence conflict" });
        }
        throw err;
      }
      logger.logSession("session.append", envelope.session_id);
      publish(envelope);
      return reply.status(201).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/sessions/:id/messages",
    async (req, reply) => {
      const sessionId = req.params.id;
      // slice-2 F-8: `Number("abc")` is `NaN`, which SQLite silently binds as NULL -- `since`
      // then matched nothing, long-polled the full timeout, and resolved `[]`. Harmless, but a
      // malformed query should fail fast with 400 rather than eat a ~25s round trip.
      let since: number | undefined;
      if (req.query.since !== undefined) {
        since = Number(req.query.since);
        if (!Number.isFinite(since)) {
          return reply.status(400).send({ error: "invalid since (must be a number)" });
        }
      }
      logger.logSession("session.read", sessionId);

      const existing = store.since(sessionId, since);
      if (existing.length > 0) return existing;

      logger.logSession("session.longpoll_start", sessionId);
      return await new Promise<Envelope[]>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          logger.logSession("session.longpoll_timeout", sessionId);
          resolve([]);
        }, longPollTimeoutMs);

        const unsubscribe = subscribe(sessionId, (envelope) => {
          if (settled) return;
          if (since !== undefined && envelope.seq <= since) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          logger.logSession("session.longpoll_resolve", sessionId);
          resolve([envelope]);
        });
      });
    },
  );

  function attachWebSocket(): void {
    const wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const match = SESSION_ID_PATH_RE.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = match[1]!;
      wss.handleUpgrade(request, socket, head, (ws) => {
        logger.logSession("session.ws_connect", sessionId);
        const unsubscribe = subscribe(sessionId, (envelope) => {
          ws.send(JSON.stringify(envelope));
        });
        ws.on("close", () => {
          unsubscribe();
          logger.logSession("session.ws_disconnect", sessionId);
        });
      });
    });
  }

  return { app, attachWebSocket };
}
