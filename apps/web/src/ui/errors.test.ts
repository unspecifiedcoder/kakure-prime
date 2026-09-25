import { describe, expect, it } from "vitest";
import { humanizeError } from "./errors.js";

describe("humanizeError", () => {
  it("maps known failures to plain language and keeps the raw text as detail", () => {
    const h = humanizeError(new Error("assembleTransferMultisig: WitnessSourceError ROOT_MISMATCH"));
    expect(h.message).toMatch(/ledger moved/i);
    expect(h.detail).toMatch(/ROOT_MISMATCH/);
  });
  it("passes unknown errors through untouched", () => {
    expect(humanizeError(new Error("something odd"))).toEqual({ message: "something odd" });
  });
});
