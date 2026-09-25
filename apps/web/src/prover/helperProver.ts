import type { CircuitId, ProofBundle, ProverPort } from "@kakure/sdk/tx";
import { decodeProofBundle, type ProveResponseBody } from "@kakure/helper/wire";

export class HelperUnauthorizedError extends Error {
  constructor() {
    super("Kakure Helper rejected the token — paste the current one from the helper's startup output");
    this.name = "HelperUnauthorizedError";
  }
}

export class HelperUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    super(`Could not reach the Kakure Helper at ${baseUrl} — is it running? (${String(cause)})`);
    this.name = "HelperUnreachableError";
  }
}

export interface HelperProverOptions {
  /** e.g. "http://127.0.0.1:8787" -- the local-only helper service, spec §3B. */
  baseUrl: string;
  /** Per-launch bearer token printed by `kakure-helper` on startup. */
  token: string;
  fetchFn?: typeof fetch;
}

/**
 * `ProverPort` (spec §2, §3B) over the Kakure Helper: the browser app posts already-built circuit
 * inputs to a LOCAL http service (never a remote one -- `baseUrl` is expected to be a 127.0.0.1
 * origin, enforced by the caller wiring this up, not by this class) and gets a `ProofBundle` back.
 * Treasury-side only per the spec: recipients get `WasmProver` instead.
 */
export function helperProver(opts: HelperProverOptions): ProverPort {
  const { baseUrl, token } = opts;
  const fetchFn = opts.fetchFn ?? fetch;

  async function request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new HelperUnreachableError(baseUrl, err);
    }
    if (res.status === 401) throw new HelperUnauthorizedError();
    return res;
  }

  return {
    async capabilities() {
      const res = await request("/health", { method: "GET" });
      if (!res.ok) {
        throw new Error(`Kakure Helper /health failed: ${res.status}`);
      }
      return (await res.json()) as { circuits: readonly CircuitId[]; environment: "native" | "wasm" };
    },
    async prove(circuit: CircuitId, inputs: Record<string, unknown>): Promise<ProofBundle> {
      const res = await request("/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ circuit, inputs }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
        throw new Error(`Kakure Helper proving failed: ${body.error ?? res.statusText}`);
      }
      const body = (await res.json()) as ProveResponseBody;
      return decodeProofBundle(body);
    },
  };
}
