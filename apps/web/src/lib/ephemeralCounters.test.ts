import { describe, expect, it } from "vitest";
import { browserEphemeralCounterStore, webStorageCounterPersistence } from "./ephemeralCounters.js";

describe("browserEphemeralCounterStore (durable self-ephemeral counter over Web Storage)", () => {
  it("never hands out the same index twice, even across a fresh store over the same storage", async () => {
    localStorage.clear();
    const a = browserEphemeralCounterStore("acct-1");
    const r1 = await a.reserve("self", 1);
    await r1.commit(r1.base);
    const r2 = await a.reserve("self", 2);
    await r2.commit(r2.base + 1);
    expect([r1.base, r2.base]).toEqual([0, 1]);

    // "Restart": a new store instance over the same localStorage continues, it does not restart at 0.
    const b = browserEphemeralCounterStore("acct-1");
    const r3 = await b.reserve("self", 1);
    expect(r3.base).toBe(3);
    expect(await b.highWater("self")).toBe(4);
  });

  it("isolates accounts by scope id and survives corrupt storage", async () => {
    localStorage.clear();
    localStorage.setItem("kakure:eph-counters:acct-2", "{not json");
    const p = webStorageCounterPersistence("acct-2");
    expect(p.read()).toEqual({});
    expect(await p.reserve("self", 1)).toBe(0);
    expect(webStorageCounterPersistence("acct-3").read()).toEqual({});
  });
});
