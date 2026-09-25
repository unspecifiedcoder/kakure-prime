import { describe, expect, it } from "vitest";
import { fieldFromHex, fieldToHex, hash2, hash3 } from "./poseidonV1.js";

describe("poseidonV1", () => {
  it("round-trips field hex <-> bigint encoding", () => {
    const hex = "0x" + "1".padStart(64, "0");
    expect(fieldFromHex(hex)).toBe(1n);
    expect(fieldToHex(1n)).toBe(hex);
    expect(fieldToHex(fieldFromHex(hex))).toBe(hex);
  });

  it("accepts hex without 0x prefix", () => {
    expect(fieldFromHex("00".repeat(31) + "05")).toBe(5n);
  });

  it("rejects non-canonical field values", () => {
    const tooLarge =
      "21888242871839275222246405745257275088548364400416034343698204186575808495617"; // == modulus
    expect(() => fieldFromHex(BigInt(tooLarge).toString(16))).toThrow();
    expect(() => fieldToHex(BigInt(tooLarge))).toThrow();
  });

  it("hash3 is deterministic and depends on all three inputs", () => {
    const a = hash3(1n, 2n, 0n);
    const b = hash3(1n, 2n, 0n);
    const c = hash3(2n, 1n, 0n);
    const d = hash3(1n, 2n, 1n);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toBeGreaterThan(0n);
  });

  it("hash2 is deterministic and depends on both inputs", () => {
    const a = hash2(1n, 2n);
    const b = hash2(1n, 2n);
    const c = hash2(2n, 1n);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
