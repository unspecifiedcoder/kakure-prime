import { describe, expect, it } from "vitest";
import { openFrom, sealTo, x25519FromEd25519Seed } from "../seal.js";

function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("crypto/seal (slice-2 F-11: HKDF-derived box key, not the raw ECDH output)", () => {
  it("round-trips a message between two parties", () => {
    const alice = x25519FromEd25519Seed(seed(1));
    const bob = x25519FromEd25519Seed(seed(2));
    const plaintext = new TextEncoder().encode("hello bob");

    const sealed = sealTo(alice.priv, bob.pub, "session-1", plaintext);
    const opened = openFrom(bob.priv, alice.pub, "session-1", sealed);
    expect(new TextDecoder().decode(opened)).toBe("hello bob");
  });

  it("the same plaintext and parties seal to different keys under different session ids", () => {
    const alice = x25519FromEd25519Seed(seed(1));
    const bob = x25519FromEd25519Seed(seed(2));
    const plaintext = new TextEncoder().encode("same message");

    // A box sealed under session-1 must not open under session-2's derived key.
    const sealedForSession1 = sealTo(alice.priv, bob.pub, "session-1", plaintext);
    expect(() => openFrom(bob.priv, alice.pub, "session-2", sealedForSession1)).toThrow();

    // But it opens correctly under the session it was actually sealed for.
    const opened = openFrom(bob.priv, alice.pub, "session-1", sealedForSession1);
    expect(new TextDecoder().decode(opened)).toBe("same message");
  });

  it("a box cannot be opened by the wrong recipient", () => {
    const alice = x25519FromEd25519Seed(seed(1));
    const bob = x25519FromEd25519Seed(seed(2));
    const mallory = x25519FromEd25519Seed(seed(3));
    const sealed = sealTo(alice.priv, bob.pub, "session-1", new TextEncoder().encode("secret"));
    expect(() => openFrom(mallory.priv, alice.pub, "session-1", sealed)).toThrow();
  });
});
