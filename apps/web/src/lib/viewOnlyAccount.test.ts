import { describe, expect, it } from "vitest";
import { Fr, deriveIncomingKey, deriveSelfSpendKey } from "@kakure/sdk";
import { ViewOnlyAccount } from "./viewOnlyAccount.js";

describe("ViewOnlyAccount", () => {
  const viewKey = new Fr(12345n);

  it("exposes the view key it was constructed with", async () => {
    const account = ViewOnlyAccount.fromViewKey(viewKey);
    expect((await account.getViewKey()).toBigInt()).toBe(viewKey.toBigInt());
  });

  it("derives the incoming key the same way a full account would", async () => {
    const account = ViewOnlyAccount.fromViewKey(viewKey);
    const expected = await deriveIncomingKey(viewKey, 3n);
    const actual = await account.getIncomingKey(3n);
    expect(actual.toBigInt()).toBe(expected.toBigInt());
  });

  it("derives the self-spend key directly from the view key (no root secret involved)", async () => {
    const account = ViewOnlyAccount.fromViewKey(viewKey);
    const expected = await deriveSelfSpendKey(viewKey);
    const actual = await account.getSelfSpendKey();
    expect(actual.toBigInt()).toBe(expected.toBigInt());
  });

  it("never serializes key material", () => {
    const account = ViewOnlyAccount.fromViewKey(viewKey);
    expect(() => account.toJSON()).toThrow();
    expect(() => JSON.stringify(account)).toThrow();
  });

  it("refuses to derive a state key (that requires the root secret, which it never has)", async () => {
    const account = ViewOnlyAccount.fromViewKey(viewKey);
    await expect(account.getStateKey()).rejects.toThrow(/root secret/);
  });
});
