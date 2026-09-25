import { describe, expect, it } from "vitest";
import { EnvelopeSchema } from "./schema.js";

const valid = {
  session_id: "a".repeat(64),
  seq: 0,
  kind: "dkg1",
  ciphertext: "aGVsbG8=",
};

describe("EnvelopeSchema (I-7)", () => {
  it("accepts a valid envelope", () => {
    expect(EnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it.each(["dkg1", "dkg2", "proposal", "nonce", "share", "final"])(
    "accepts kind=%s",
    (kind) => {
      expect(() => EnvelopeSchema.parse({ ...valid, kind })).not.toThrow();
    },
  );

  it("rejects a non-hex32 session_id", () => {
    expect(() => EnvelopeSchema.parse({ ...valid, session_id: "not-hex" })).toThrow();
    expect(() => EnvelopeSchema.parse({ ...valid, session_id: "a".repeat(63) })).toThrow();
  });

  it("rejects a negative or non-integer seq", () => {
    expect(() => EnvelopeSchema.parse({ ...valid, seq: -1 })).toThrow();
    expect(() => EnvelopeSchema.parse({ ...valid, seq: 1.5 })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => EnvelopeSchema.parse({ ...valid, kind: "bogus" })).toThrow();
  });

  it("rejects non-base64 ciphertext", () => {
    expect(() => EnvelopeSchema.parse({ ...valid, ciphertext: "not base64!" })).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => EnvelopeSchema.parse({ seq: 0, kind: "dkg1", ciphertext: "aGk=" })).toThrow();
  });
});
