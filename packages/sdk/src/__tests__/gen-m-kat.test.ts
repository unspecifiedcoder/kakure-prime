import { describe, it, expect } from "vitest";
import { msgWithdraw, msgTransfer, msgSplit, msgJoin } from "../frost/index.js";

// Parity lock: these m values MUST match Noir shared/src/multisig/frost.nr kat_msg_parity.
// regenerated for kakure.* domains (SCHNORR_DOMAIN/ACTION_* moved)
describe("m-preimage TS<->Noir parity", () => {
  it("msg_* match the Noir KAT for fixed inputs", async () => {
    const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
    expect(
      hex(
        await msgWithdraw({
          root: 1n,
          nullifier: 2n,
          changeLeaf: 3n,
          publicOut: 4n,
          asset: 5n,
          recipient: 6n,
          intentHash: 7n,
        }),
      ),
    ).toBe(
      "0x21f66081a6ec294ce6d480cc98829c7170174caf9bc789b9b0ca9e47951e87c1",
    );
    expect(
      hex(
        await msgTransfer({
          root: 1n,
          nullifier: 2n,
          memoLeaf: 3n,
          memoTag: 4n,
          changeLeaf: 5n,
          asset: 6n,
        }),
      ),
    ).toBe(
      "0x123055eca632774fa61023ad17634974d6e92a54a1007444ffde6d4235c8dcf6",
    );
    expect(
      hex(
        await msgSplit({
          root: 1n,
          nullifier: 2n,
          out1Leaf: 3n,
          out2Leaf: 4n,
          asset: 5n,
        }),
      ),
    ).toBe(
      "0x2da48727cf45aa5d2365949fc63a30c31a237f433b1d28a0ba8ae5f84024ba52",
    );
    expect(
      hex(
        await msgJoin({
          root: 1n,
          nullifierA: 2n,
          nullifierB: 3n,
          outLeaf: 4n,
          asset: 5n,
        }),
      ),
    ).toBe(
      "0x0f88a1c9580cc6394442ea59bdb3f8cd26a55da6e8d81e3cac6a90d012b4c125",
    );
  });
});
