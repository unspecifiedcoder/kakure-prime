import { describe, expect, it } from "vitest";
import { createProposal } from "../proposal.js";
import { deriveSessionKey } from "../../crypto/sessionSeal.js";

const SESSION = "session-f2";

/**
 * slice-2 F-2: every envelope posted to the coordinator on a group's session must be sealed under
 * the session key -- not parseable JSON, and never containing the plaintext message/details/
 * recipient verbatim. Before the fix, `createProposal` posted `base64(JSON.stringify(payload))`:
 * anyone with the session id (the coordinator operator, or an unauthenticated poster per F-3)
 * could read the spend's kind/message/details/recipient/amount straight off the wire.
 */
describe("slice-2 F-2: proposal envelopes are sealed, not plaintext", () => {
  it("no envelope body posted to the coordinator is parseable JSON or contains the message/recipient", async () => {
    const posted: string[] = [];
    const fake = {
      appendNext: async (_s: string, _k: string, ct: string) => {
        posted.push(ct);
        return {} as never;
      },
      collectUntil: async () => [] as never[],
    };
    const sessionKey = deriveSessionKey(new Uint8Array(32).fill(9), SESSION);

    await createProposal(fake as never, SESSION, sessionKey, {
      kind: "withdraw",
      proposalId: "p1",
      messageHex: "0x1234",
      details: { recipient: "R" },
    });

    expect(posted.length).toBeGreaterThan(0);
    for (const ct of posted) {
      const bytes = Buffer.from(ct, "base64");
      expect(() => JSON.parse(bytes.toString("utf8"))).toThrow();
      expect(bytes.toString("utf8")).not.toContain("0x1234");
      expect(bytes.toString("utf8")).not.toContain("recipient");
    }
  });

  it("a party without the session key cannot read the envelope, but the right key round-trips it", async () => {
    const posted: string[] = [];
    const fake = {
      appendNext: async (_s: string, _k: string, ct: string) => {
        posted.push(ct);
        return {} as never;
      },
      collectUntil: async () => [] as never[],
    };
    const rightKey = deriveSessionKey(new Uint8Array(32).fill(1), SESSION);
    const wrongKey = deriveSessionKey(new Uint8Array(32).fill(2), SESSION);

    await createProposal(fake as never, SESSION, rightKey, {
      kind: "transfer",
      proposalId: "p2",
      messageHex: "0xabcd",
      details: { amount: "1000000" },
    });

    const { openSessionJson } = await import("../../crypto/sessionSeal.js");
    expect(() => openSessionJson(wrongKey, posted[0]!)).toThrow();
    expect(openSessionJson<{ proposalId: string }>(rightKey, posted[0]!).proposalId).toBe("p2");
  });
});
