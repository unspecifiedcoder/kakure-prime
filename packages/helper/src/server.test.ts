import { describe, it, expect, vi } from "vitest";
import type { ProverPort } from "@kakure/sdk/tx";
import { CircuitId } from "@kakure/sdk/tx";
import { buildHelperApi, generateToken } from "./server.js";
import { decodeProofBundle } from "./wire.js";

function fakeProverPort(overrides: Partial<ProverPort> = {}): ProverPort {
  return {
    capabilities: vi.fn(async () => ({ circuits: [CircuitId.Deposit], environment: "native" as const })),
    prove: vi.fn(async (circuitId: CircuitId) => ({
      circuitId,
      proof: new Uint8Array(192).fill(7),
      publicInputs: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
    })),
    ...overrides,
  };
}

describe("@kakure/helper server (ws-I §3B: local prover service)", () => {
  it("generateToken returns a fresh 64-char hex string each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("rejects /prove without the bearer token", async () => {
    const { app } = buildHelperApi({ proverPort: fakeProverPort(), token: "secret-token" });
    const res = await app.inject({ method: "POST", url: "/prove", payload: { circuit: CircuitId.Deposit, inputs: {} } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects /prove with the wrong bearer token", async () => {
    const { app } = buildHelperApi({ proverPort: fakeProverPort(), token: "secret-token" });
    const res = await app.inject({
      method: "POST",
      url: "/prove",
      headers: { authorization: "Bearer wrong" },
      payload: { circuit: CircuitId.Deposit, inputs: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it("/health requires no token and reports capabilities", async () => {
    const { app } = buildHelperApi({ proverPort: fakeProverPort(), token: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ circuits: [CircuitId.Deposit], environment: "native" });
  });

  it("proves and returns a base64-wire ProofBundle that round-trips through decodeProofBundle", async () => {
    const port = fakeProverPort();
    const { app } = buildHelperApi({ proverPort: port, token: "secret-token" });
    const res = await app.inject({
      method: "POST",
      url: "/prove",
      headers: { authorization: "Bearer secret-token" },
      payload: { circuit: CircuitId.Deposit, inputs: { amount: 1000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(port.prove).toHaveBeenCalledWith(CircuitId.Deposit, { amount: 1000 });

    const bundle = decodeProofBundle(res.json());
    expect(bundle.circuitId).toBe(CircuitId.Deposit);
    expect([...bundle.proof]).toEqual(new Array(192).fill(7));
    expect(bundle.publicInputs).toHaveLength(2);
    expect([...bundle.publicInputs[0]!]).toEqual(new Array(32).fill(1));
  });

  it("rejects a malformed body", async () => {
    const { app } = buildHelperApi({ proverPort: fakeProverPort(), token: "secret-token" });
    const res = await app.inject({
      method: "POST",
      url: "/prove",
      headers: { authorization: "Bearer secret-token" },
      payload: { circuit: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("surfaces a proving failure as a 500 with the error message, never crashing the process", async () => {
    const port = fakeProverPort({
      prove: vi.fn(async () => {
        throw new Error("artifacts missing for transfer_multisig");
      }),
    });
    const { app } = buildHelperApi({ proverPort: port, token: "secret-token" });
    const res = await app.inject({
      method: "POST",
      url: "/prove",
      headers: { authorization: "Bearer secret-token" },
      payload: { circuit: CircuitId.TransferMultisig, inputs: {} },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/artifacts missing/);
  });
});
