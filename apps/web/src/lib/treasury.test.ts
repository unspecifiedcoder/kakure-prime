import { describe, it, expect } from "vitest";
import { encodeInvite, decodeInvite, type TreasuryInvite } from "./treasury.js";

describe("treasury invite link (spec §4: no secrets in a shared link)", () => {
  it("round-trips coordinator url, session id and ceremony params", () => {
    const invite: TreasuryInvite = {
      coordinatorUrl: "http://127.0.0.1:8789",
      sessionId: "a".repeat(64),
      name: "Payroll ops",
      threshold: 3,
      memberCount: 5,
    };
    const token = encodeInvite(invite);
    expect(decodeInvite(token)).toEqual(invite);
  });

  it("the encoded token is URL-safe (no +, /, or = padding)", () => {
    const token = encodeInvite({
      coordinatorUrl: "http://127.0.0.1:8789",
      sessionId: "b".repeat(64),
      name: "Test / treasury + more",
      threshold: 2,
      memberCount: 3,
    });
    expect(token).not.toMatch(/[+/=]/);
  });

  it("carries no key material -- only strings/numbers a public link is safe to expose", () => {
    const invite: TreasuryInvite = {
      coordinatorUrl: "http://127.0.0.1:8789",
      sessionId: "c".repeat(64),
      name: "Payroll",
      threshold: 3,
      memberCount: 5,
    };
    const decoded = decodeInvite(encodeInvite(invite));
    expect(Object.keys(decoded).sort()).toEqual(
      ["coordinatorUrl", "memberCount", "name", "sessionId", "threshold"].sort(),
    );
  });
});
