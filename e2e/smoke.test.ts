import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalnet, type Localnet } from "./localnet.js";

/**
 * Master plan Workstream F.1: proves the localnet harness itself works, before anything scenario-shaped
 * is layered on top -- validator up, all 9 programs (kakure_pool, mock_verifier, 7 real verifiers)
 * executable, indexer `/root` responding, coordinator accepting a `POST`.
 *
 * `just e2e-smoke` runs this file alone. Only one `solana-test-validator` at a time on this sandbox.
 */
describe("localnet smoke test", () => {
  let net: Localnet;

  beforeAll(async () => {
    net = await startLocalnet({ logToConsole: false });
  }, 120_000);

  afterAll(async () => {
    await net?.stop();
  });

  it("boots a validator with all 9 programs executable", async () => {
    const ids = [
      net.programIds.kakurePool,
      net.programIds.mockVerifier,
      ...Object.values(net.programIds.verifiers),
    ];
    expect(ids).toHaveLength(9);
    for (const id of ids) {
      const info = await net.connection.getAccountInfo(id);
      expect(info, `expected ${id.toBase58()} to exist`).not.toBeNull();
      expect(info!.executable, `expected ${id.toBase58()} to be executable`).toBe(true);
    }
  });

  it("airdropped and minted for the payer", async () => {
    const balance = await net.connection.getBalance(net.payer.publicKey);
    expect(balance).toBeGreaterThan(0);
    const tokenBalance = await net.connection.getTokenAccountBalance(net.payerTokenAccount);
    expect(BigInt(tokenBalance.value.amount)).toBeGreaterThan(0n);
  });

  it("indexer /root responds", async () => {
    const res = await fetch(`${net.indexerUrl}/root`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { root: string; next_leaf_index: number; roots: string[] };
    expect(typeof body.root).toBe("string");
    expect(body.roots).toHaveLength(256);
  });

  it("coordinator accepts a POST message", async () => {
    const sessionId = "1".repeat(64);
    const res = await fetch(`${net.coordinatorUrl}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, seq: 0, kind: "dkg1", ciphertext: "AAAA" }),
    });
    expect(res.status).toBe(201);
  });
});
