import { describe, it, expect, beforeAll } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import {
  deriveViewKey,
  deriveIncomingKey,
  deriveSelfSpendKey,
  publicKey,
  pubkeyOwner,
  isEvenY,
  discoveryTag,
  canonicalIncomingAddress,
} from "../note/keys";

const frHex = (f: Fr): string => "0x" + f.toBuffer().toString("hex");

const SK_ROOT = new Fr(0x2an);

// regenerated for kakure.* domains (IN_KEY_LABEL moved, so every derived point below moved with it).
// Index 1/2 (the pair the pre-rename fixture used) are now BOTH even-y under the new label, so the
// odd/even example pair and the roll-start index were re-picked from the new derivation sequence;
// this KAT no longer happens to numerically match circuits/shared/src/common/even_y.nr's fixture
// points (those are arbitrary, domain-independent constants -- not derived via any Kdf label -- so
// they did not need to change and the coincidental match with this file's old constants was never load-bearing).
const OWNER_INCOMING_J0 =
  "0x20c5ff887c4616100c81b0d89c0200f24ff1b9bf9380eca5fc1288311451e025";
const OWNER_SELF =
  "0x2596656197bc27468be5f369857735d02630b57403ae50938d7497d6f5592833";

const IN_PUB_ODD_X =
  0x052ef82e5894eb67118e25511306f27a31dd2986726403f85e2978361e94256dn;
const IN_PUB_ODD_Y =
  0x04735857fd3fc80327237e02835fbfaea1ecd6cd02400f0333f1dac7f0439735n;
const IN_PUB_EVEN_X =
  0x27732f898dad70e45efd46c8ea4012c53ae095b28a32f6788b44314d47537c0en;
const IN_PUB_EVEN_Y =
  0x183ceb36bbd1b8aecc2c97061f8ebbdf895ed9132c263797e04d1215e9ec8d6n;

const FIXTURE_IN_PUB_X =
  0x158b1d9682257c0832785c20b002c360b7f84f59f253e667659cf90c1455f764n;
const FIXTURE_IN_PUB_Y =
  0x132a0f65758b4775374cfc0a98d7f8a186e1cad626e4e4cd37b73532d7e50101n;

describe("Option-A key derivations + owner + even-y tags", () => {
  let sk_view: Fr;

  beforeAll(async () => {
    sk_view = await deriveViewKey(SK_ROOT);
  });

  it("derives the incoming-note owner (j=0)", async () => {
    const owner = await pubkeyOwner(
      publicKey(await deriveIncomingKey(sk_view, 0n)),
    );
    expect(frHex(owner)).toBe(OWNER_INCOMING_J0);
  });

  it("derives the self-note owner", async () => {
    const owner = await pubkeyOwner(
      publicKey(await deriveSelfSpendKey(sk_view)),
    );
    expect(frHex(owner)).toBe(OWNER_SELF);
  });

  it("agrees with the KAT points and their y-parity", async () => {
    const oddPub = publicKey(await deriveIncomingKey(sk_view, 0n));
    const evenPub = publicKey(await deriveIncomingKey(sk_view, 1n));
    expect(oddPub[0]).toBe(IN_PUB_ODD_X);
    expect(oddPub[1]).toBe(IN_PUB_ODD_Y);
    expect(evenPub[0]).toBe(IN_PUB_EVEN_X);
    expect(evenPub[1]).toBe(IN_PUB_EVEN_Y);
    expect(isEvenY(oddPub)).toBe(false);
    expect(isEvenY(evenPub)).toBe(true);
  });

  it("rolls an odd-y index to the next even-y index for the canonical tag", async () => {
    // regenerated for kakure.* domains: indices 3-6 are all odd-y under the new label, so the
    // roll now runs to index 7 (was index 1 -> 2 pre-rename).
    const canonical = await canonicalIncomingAddress(sk_view, 3n);
    expect(canonical.index).toBe(7n);
    expect(isEvenY(canonical.pub)).toBe(true);
    expect(discoveryTag(canonical.pub).toBigInt()).toBe(canonical.tag.toBigInt());
  });

  it("rejects the shared-fixture odd-y point (in_key_j = 789)", () => {
    const fixture = mulPointEscalar(Base8, 789n);
    expect(fixture[0]).toBe(FIXTURE_IN_PUB_X);
    expect(fixture[1]).toBe(FIXTURE_IN_PUB_Y);
    expect(isEvenY(fixture)).toBe(false);
  });

  it("owner of the fixture in_pub_j matches the Noir owner KAT and the DEM owner field", async () => {
    const owner = await pubkeyOwner(mulPointEscalar(Base8, 789n));
    expect(frHex(owner)).toBe(
      "0x2874ae964d8b283e2f521a7f14125fc92747bb9770139b8d4b70ee09e2d83785",
    );
  });
});
