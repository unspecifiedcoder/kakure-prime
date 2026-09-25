import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { CoordinatorClient } from "../../coordinatorClient.js";
import { FakeCoordinator } from "../../__tests__/fakes/fakeCoordinator.js";
import { x25519FromEd25519Seed } from "../../crypto/seal.js";
import { runDkgCeremony, type DkgCeremonyOptions } from "../ceremony.js";

const SESSION = "session-f3";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Builds a round-1 "dkg1" envelope ciphertext (base64 JSON, matching `Announce`'s shape in
 * `ceremony.ts`) claiming `edPubHex` with `x25519Pub`, WITHOUT a valid signature over that
 * identity -- i.e. exactly what an attacker who does not hold `edPubHex`'s ed25519 seed can
 * produce. `sig` is garbage (an attacker without the seed cannot compute a real one).
 */
function forgedAnnounceFor(edPub: Uint8Array, x25519Pub: Uint8Array): string {
  const announce = {
    kind: "announce",
    edPubHex: hex(edPub),
    x25519PubHex: hex(x25519Pub),
    sig: hex(new Uint8Array(64)), // garbage: not a real ed25519 signature
  };
  return b64(new TextEncoder().encode(JSON.stringify(announce)));
}

describe("slice-2 F-3: round-1 announces are authenticated and non-overwritable", () => {
  let fake: FakeCoordinator;
  let url: string;

  beforeEach(async () => {
    fake = new FakeCoordinator(50);
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("a conflicting announce for an existing identity aborts the ceremony instead of replacing its X25519 key", async () => {
    const victim = Keypair.generate();
    const attacker = Keypair.generate();
    const other = Keypair.generate();

    // Attacker re-announces the victim's identity with the attacker's own X25519 key, WITHOUT a
    // valid signature (they don't hold the victim's ed25519 seed) -- exactly the I-7 attack: the
    // session id is a bearer capability, so anyone holding it can POST directly to the coordinator.
    const attackerX25519 = x25519FromEd25519Seed(attacker.secretKey.slice(0, 32));
    fake.inject(SESSION, "dkg1", forgedAnnounceFor(victim.publicKey.toBytes(), attackerX25519.pub));

    const base: Omit<DkgCeremonyOptions, "coordinator" | "ed25519Seed" | "ed25519PublicKey"> = {
      sessionId: SESSION,
      threshold: 2,
      memberCount: 2,
      context: 0xabcdefn,
      maxRounds: 20,
    };

    await expect(
      Promise.all([
        runDkgCeremony({
          ...base,
          coordinator: new CoordinatorClient(url),
          ed25519Seed: victim.secretKey.slice(0, 32),
          ed25519PublicKey: victim.publicKey.toBytes(),
        }),
        runDkgCeremony({
          ...base,
          coordinator: new CoordinatorClient(url),
          ed25519Seed: other.secretKey.slice(0, 32),
          ed25519PublicKey: other.publicKey.toBytes(),
        }),
      ]),
    ).rejects.toThrow(/conflicting announce|bad announce signature/);

    // Nobody dealt shares: the ceremony aborted before round 2, so the victim's share was never
    // sealed to the attacker's X25519 key.
    expect(fake.envelopes(SESSION).filter((e) => e.kind === "dkg2")).toHaveLength(0);
  });
});
