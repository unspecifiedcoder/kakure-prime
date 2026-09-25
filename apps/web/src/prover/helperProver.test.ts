import { describe, it, expect, vi } from "vitest";
import { CircuitId } from "@kakure/sdk/tx";
import { encodeProofBundle } from "@kakure/helper/wire";
import { helperProver, HelperUnauthorizedError, HelperUnreachableError } from "./helperProver.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("helperProver (ws-I §3B browser client)", () => {
  it("sends the bearer token and decodes a successful ProofBundle", async () => {
    const bundle = {
      circuitId: CircuitId.Deposit,
      proof: new Uint8Array(192).fill(9),
      publicInputs: [new Uint8Array(32).fill(1)],
    };
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
      return jsonResponse(200, encodeProofBundle(bundle));
    });
    const port = helperProver({ baseUrl: "http://127.0.0.1:8787", token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });
    const result = await port.prove(CircuitId.Deposit, { amount: 1 });
    expect(result.circuitId).toBe(CircuitId.Deposit);
    expect([...result.proof]).toEqual([...bundle.proof]);
  });

  it("throws HelperUnauthorizedError on 401", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const port = helperProver({ baseUrl: "http://127.0.0.1:8787", token: "wrong", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(port.prove(CircuitId.Deposit, {})).rejects.toBeInstanceOf(HelperUnauthorizedError);
  });

  it("throws HelperUnreachableError when the fetch itself fails (helper not running)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const port = helperProver({ baseUrl: "http://127.0.0.1:8787", token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(port.prove(CircuitId.Deposit, {})).rejects.toBeInstanceOf(HelperUnreachableError);
  });

  it("surfaces the helper's error message on a non-401 failure", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: "artifacts missing" }));
    const port = helperProver({ baseUrl: "http://127.0.0.1:8787", token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(port.prove(CircuitId.Deposit, {})).rejects.toThrow(/artifacts missing/);
  });

  it("capabilities() hits /health and does not require the endpoint to be authenticated to succeed", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { circuits: [CircuitId.Deposit], environment: "native" }));
    const port = helperProver({ baseUrl: "http://127.0.0.1:8787", token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });
    const caps = await port.capabilities();
    expect(caps.environment).toBe("native");
  });
});
