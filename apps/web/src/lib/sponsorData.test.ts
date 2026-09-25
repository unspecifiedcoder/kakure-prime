import { describe, expect, it } from "vitest";
import { navPremium } from "./sponsorData.js";

describe("navPremium", () => {
  it("computes the token premium to the PreStocks mark", () => {
    expect(navPremium({ markPrice: 100, tokenPrice: 105 })).toBe(5);
  });

  it("reports discounts as negative", () => {
    expect(navPremium({ markPrice: 200, tokenPrice: 180 })).toBe(-10);
  });
});
