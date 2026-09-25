import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { ProverPort } from "@kakure/sdk/tx";
import { decodeProofBundle, encodeProofBundle, type ProveRequestBody, type ProveResponseBody } from "./wire.js";

export interface HelperApiOptions {
  /** Allowed browser origin(s) for CORS. Default: see the register call below. */
  readonly corsOrigin?: string | boolean | RegExp | string[];
  proverPort: ProverPort;
  /** Bearer token every `/prove` request must present. Generate one with `generateToken()`. */
  token: string;
}

export interface HelperApi {
  app: FastifyInstance;
}

/** A fresh, unguessable per-launch token (256 bits, hex-encoded) -- printed once at process start,
 *  never persisted, never logged by the server itself. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * §3B "Kakure Helper": a tiny local HTTP service wrapping `@kakure/prover`'s native `ProverPort` so
 * the browser app never needs `sunspot`/filesystem access. Binds to 127.0.0.1 only (enforced by the
 * caller passing that host to `app.listen`, see `cli.ts`); every request must carry the per-launch
 * bearer token. The service never sees spend keys -- only already-built circuit `inputs` (which do
 * contain the caller's witness values) and returns a `ProofBundle`; nothing is persisted or logged.
 */
export function buildHelperApi(opts: HelperApiOptions): HelperApi {
  const { proverPort, token } = opts;
  const app = Fastify({ logger: false });
  // CORS: the helper proves with the user's secrets, so only the configured app origin may call it.
  void app.register(cors, { origin: opts.corsOrigin ?? /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/, methods: ["POST","GET","OPTIONS"], allowedHeaders: ["authorization","content-type"] });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return; // capabilities probe needs no auth to keep the UI's "is it running?" check simple
    const auth = req.headers.authorization;
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => {
    return proverPort.capabilities();
  });

  app.post<{ Body: ProveRequestBody }>("/prove", async (req, reply) => {
    const body = req.body;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.circuit !== "number" ||
      typeof body.inputs !== "object" ||
      body.inputs === null
    ) {
      await reply.code(400).send({ error: "expected { circuit: number, inputs: object }" });
      return;
    }
    try {
      const bundle = await proverPort.prove(body.circuit, body.inputs);
      const wire: ProveResponseBody = encodeProofBundle(bundle);
      return wire;
    } catch (err) {
      await reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  });

  return { app };
}

export { decodeProofBundle, encodeProofBundle };
export type { ProveRequestBody, ProveResponseBody };
