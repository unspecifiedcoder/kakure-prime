import { describe, expect, it } from "vitest";
import { navPremium, preStockRisk, pythRisk, type PreStock, type PythMarketStatus } from "./sponsorData.js";

describe("navPremium", () => {
  it("computes the token premium to the PreStocks mark", () => {
    expect(navPremium({ markPrice: 100, tokenPrice: 105 })).toBe(5);
  });

  it("reports discounts as negative", () => {
    expect(navPremium({ markPrice: 200, tokenPrice: 180 })).toBe(-10);
  });
});

describe("sponsor settlement policy", () => {
  const stock: PreStock = {
    name: "Anthropic PreStocks",
    symbol: "ANTHROPIC",
    contractAddress: "9xQeWvG816bUx9EPfEZBDLwt7uKve6LodPQgZnWGz4L",
    markPrice: 100,
    tokenPrice: 105,
    onChainVerified: true,
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  };

  it("allows only a valid official mint inside the premium mandate", () => {
    expect(preStockRisk(stock)).toEqual({ passed: true, reason: "official asset · NAV guard passed" });
    expect(preStockRisk({ ...stock, tokenPrice: 130 }).passed).toBe(false);
    expect(preStockRisk({ ...stock, contractAddress: "not-a-mint" }).passed).toBe(false);
    expect(preStockRisk({ ...stock, onChainVerified: false }).passed).toBe(false);
  });

  it("requires a fresh, confident Pyth price before passing the risk gate", () => {
    const status: PythMarketStatus = {
      symbol: "Crypto.AAPLX/USD",
      feedId: "feed",
      isOpen: true,
      nextOpen: null,
      nextClose: null,
      price: 250,
      confidence: 0.25,
      publishTime: 1_000,
      mode: "price",
    };
    expect(pythRisk(status, 1_010).passed).toBe(true);
    expect(pythRisk(status, 1_031).passed).toBe(false);
    expect(pythRisk({ ...status, price: null, confidence: null, publishTime: null }, 1_010).passed).toBe(false);
  });
});
