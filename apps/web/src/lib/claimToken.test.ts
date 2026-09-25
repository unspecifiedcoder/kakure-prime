import { describe, it, expect } from "vitest";
import { encodeClaimToken, decodeClaimToken, type ClaimToken } from "./claimToken.js";

describe("claim token (spec §1.2: no secrets, no install)", () => {
  it("round-trips indexer url, address hint and leaf range", () => {
    const token: ClaimToken = {
      indexerUrl: "http://127.0.0.1:8788",
      incomingAddressHint: "0xabc123...",
      fromLeaf: 100,
      toLeaf: 140,
    };
    expect(decodeClaimToken(encodeClaimToken(token))).toEqual(token);
  });

  it("carries only the four documented fields -- never a view/spend key", () => {
    const decoded = decodeClaimToken(
      encodeClaimToken({ indexerUrl: "http://x", incomingAddressHint: "hint", fromLeaf: 0, toLeaf: 1 }),
    );
    expect(Object.keys(decoded).sort()).toEqual(["fromLeaf", "incomingAddressHint", "indexerUrl", "toLeaf"]);
  });

  it("rejects a malformed/corrupted token instead of silently returning garbage", () => {
    expect(() => decodeClaimToken("not-valid-base64url!!")).toThrow();
    const missingField = btoa(JSON.stringify({ indexerUrl: "http://x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(() => decodeClaimToken(missingField)).toThrow(/malformed/);
  });
});
