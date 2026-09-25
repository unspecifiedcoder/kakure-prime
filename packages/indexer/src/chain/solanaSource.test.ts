import { describe, expect, it } from "vitest";
import { SolanaChainSource } from "./solanaSource.js";
import type { ChainSource } from "./types.js";

describe("SolanaChainSource", () => {
  it("constructs against a devnet-shaped RPC URL without making a network call", () => {
    const source: ChainSource = new SolanaChainSource("http://127.0.0.1:8899");
    expect(typeof source.getSignaturesForAddress).toBe("function");
    expect(typeof source.getTransaction).toBe("function");
    expect(typeof source.onLogs).toBe("function");
  });
});
