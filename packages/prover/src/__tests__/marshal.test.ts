import { describe, expect, it } from "vitest";
import { Fr } from "@kakure/sdk";
import { marshalNote, marshalU128, memoRecipientPoints, pointHex, type NoteInput } from "../marshal.js";
import { ProofInputError } from "../errors.js";

const note = (overrides: Partial<NoteInput> = {}): NoteInput => ({
  noteVersion: new Fr(1n),
  assetId: new Fr(0x1234n),
  noteType: new Fr(0n),
  conditionsHash: new Fr(0n),
  value: new Fr(100n),
  owner: new Fr(7n),
  psi: new Fr(9n),
  parents: new Fr(0n),
  ...overrides,
});

describe("pointHex", () => {
  it("hex-encodes both coordinates with a 0x prefix", () => {
    expect(pointHex([255n, 16n])).toEqual({ x: "0xff", y: "0x10" });
  });
});

describe("marshalU128", () => {
  it("stringifies a value within u128 range to Fr's canonical hex form", () => {
    expect(marshalU128("withdraw", "withdraw_value", new Fr(42n))).toBe(new Fr(42n).toString());
  });

  it("rejects a value exceeding u128 range", () => {
    expect(() => marshalU128("withdraw", "withdraw_value", new Fr(1n << 128n))).toThrow(
      ProofInputError,
    );
  });
});

describe("marshalNote", () => {
  it("flattens every Note field to Fr's canonical (hex) string, in ABI field order", () => {
    const n = note();
    expect(marshalNote("deposit", n)).toEqual({
      note_version: n.noteVersion.toString(),
      asset_id: n.assetId.toString(),
      note_type: n.noteType.toString(),
      conditions_hash: n.conditionsHash.toString(),
      value: n.value.toString(),
      owner: n.owner.toString(),
      psi: n.psi.toString(),
      parents: n.parents.toString(),
    });
  });

  it("rejects a note value exceeding u128 range", () => {
    expect(() => marshalNote("deposit", note({ value: new Fr(1n << 128n) }))).toThrow(
      ProofInputError,
    );
  });
});

describe("memoRecipientPoints", () => {
  const standardPub: [bigint, bigint] = [1n, 2n];
  const gpk: [bigint, bigint] = [3n, 4n];
  const viewPub: [bigint, bigint] = [5n, 6n];

  it("uses recipientInPub for both spend and view on a STANDARD memo", () => {
    const result = memoRecipientPoints("transfer", new Fr(0n), standardPub);
    expect(result).toEqual({ spend: standardPub, view: standardPub });
  });

  it("uses the decoupled gpk/viewPub for a MULTISIG memo", () => {
    const result = memoRecipientPoints("transfer_multisig", new Fr(1n), undefined, { gpk, viewPub });
    expect(result).toEqual({ spend: gpk, view: viewPub });
  });

  it("rejects passing both recipientInPub and recipientMultisig", () => {
    expect(() =>
      memoRecipientPoints("transfer", new Fr(1n), standardPub, { gpk, viewPub }),
    ).toThrow(ProofInputError);
  });

  it("rejects recipientMultisig on a STANDARD memo", () => {
    expect(() => memoRecipientPoints("transfer", new Fr(0n), undefined, { gpk, viewPub })).toThrow(
      ProofInputError,
    );
  });

  it("rejects recipientInPub on a MULTISIG memo", () => {
    expect(() => memoRecipientPoints("transfer", new Fr(1n), standardPub)).toThrow(ProofInputError);
  });

  it("rejects gpk and viewPub sharing an x-coordinate", () => {
    expect(() =>
      memoRecipientPoints("transfer_multisig", new Fr(1n), undefined, { gpk, viewPub: gpk }),
    ).toThrow(ProofInputError);
  });

  it("rejects passing neither option", () => {
    expect(() => memoRecipientPoints("transfer", new Fr(0n))).toThrow(ProofInputError);
  });
});
