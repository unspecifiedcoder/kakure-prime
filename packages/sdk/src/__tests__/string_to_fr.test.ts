import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { stringToFr } from "../crypto/fields";

describe("stringToFr Cross-Language Compatibility", () => {
  it('should match the known Noir output for "kakure.enc_key"', async () => {
    // regenerated for kakure.* domains
    const expectedNoirOutput = new Fr(
      0x25b8520d59944d2bfec7339806f62880c7615585afeb6ec974500bd6fc81ed26n,
    );

    const tsOutput = await stringToFr("kakure.enc_key");
    expect(tsOutput.equals(expectedNoirOutput)).toBe(true);
  });
});
