import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, shortAddress } from "./format.js";

describe("format helpers", () => {
  it("formats smallest units as human amounts and round-trips", () => {
    expect(formatAmount(1_500_250_000n, 6, "USDC")).toBe("1,500.25 USDC");
    expect(formatAmount(400_000n, 6)).toBe("0.4");
    expect(formatAmount(3000n)).toBe("3000");
    expect(parseAmount("1,500.25", 6)).toBe(1_500_250_000n);
    expect(parseAmount("0.4", 6)).toBe(400_000n);
    expect(() => parseAmount("1.2345678", 6)).toThrow(/decimal places/);
    expect(() => parseAmount("abc", 6)).toThrow(/not an amount/);
  });
  it("shortens addresses", () => {
    expect(shortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
  });
});
