import { describe, it, expect } from "vitest";
import { CircuitId } from "@kakure/sdk/tx";
import { proverFor } from "./router.js";

const helperOpts = { helper: { baseUrl: "http://127.0.0.1:8787", token: "tok" } };

describe("proverFor router (ws-J routing: real wasm for deposit/withdraw, helper for the payroll batch)", () => {
  it("routes Deposit to the wasm prover (environment: wasm, no helper call)", async () => {
    const port = proverFor(CircuitId.Deposit, helperOpts);
    const caps = await port.capabilities();
    expect(caps.environment).toBe("wasm");
    expect(caps.circuits).toContain(CircuitId.Deposit);
  });

  it("routes Withdraw to the wasm prover", async () => {
    const port = proverFor(CircuitId.Withdraw, helperOpts);
    const caps = await port.capabilities();
    expect(caps.environment).toBe("wasm");
    expect(caps.circuits).toContain(CircuitId.Withdraw);
  });

  it("routes TransferMultisig to the helper prover, not wasm (helper unreachable in this test is fine -- proves it isn't silently using wasm)", async () => {
    const port = proverFor(CircuitId.TransferMultisig, helperOpts);
    await expect(port.capabilities()).rejects.toThrow(/Kakure Helper/);
  });

  it("defaults every other circuit to the helper prover", async () => {
    for (const id of [CircuitId.Transfer, CircuitId.SplitMultisig, CircuitId.JoinMultisig, CircuitId.WithdrawMultisig]) {
      const port = proverFor(id, helperOpts);
      await expect(port.capabilities()).rejects.toThrow(/Kakure Helper/);
    }
  });
});
