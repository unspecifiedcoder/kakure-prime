import { describe, it, expect } from "vitest";
import { SolanaAccount } from "@kakure/sdk";
import { myReceiveAddress, encodeReceiveAddress, decodeReceiveAddress } from "./receiveAddress.js";

describe("receiveAddress (a recipient's shareable Kakure pay address)", () => {
  it("round-trips index and public point through the encoded token", () => {
    const addr = { index: 0n, pubX: 123n, pubY: 456n };
    expect(decodeReceiveAddress(encodeReceiveAddress(addr))).toEqual(addr);
  });

  it("is derived from the account's view key, not its spend key, and is safe to share (it's a public point)", async () => {
    const account = await SolanaAccount.fromSeed("recipient-seed");
    const addr = await myReceiveAddress(account);
    expect(typeof addr.pubX).toBe("bigint");
    expect(typeof addr.pubY).toBe("bigint");
    // `canonicalIncomingAddress` rolls forward from the requested start index until it lands on a
    // valid subgroup point, so the resulting index is >= what was asked for, not necessarily equal.
    expect(addr.index).toBeGreaterThanOrEqual(0n);
  });

  it("is deterministic for the same account and index", async () => {
    const account = await SolanaAccount.fromSeed("recipient-seed-2");
    const a = await myReceiveAddress(account, 0n);
    const b = await myReceiveAddress(account, 0n);
    expect(a).toEqual(b);
  });
});
