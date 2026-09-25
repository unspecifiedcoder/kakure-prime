/**
 * A durable `EphemeralCounterStore` for the browser: `@kakure/sdk`'s `PersistentEphemeralCounterStore`
 * over Web Storage. `KeyRepository` (the claim page's full-account scan/withdraw) refuses to mint
 * without a durable counter -- a forgotten counter reissues self-ephemeral index 0 on the next
 * visit: same CEK, repeated DEM keystream, byte-identical `ephemeralPK_x` in two events.
 *
 * Keyed per account (the storage key includes a public identifier the caller supplies -- never a
 * key) so two recipients sharing a browser profile never share a counter. `localStorage` is
 * synchronous, which is exactly what `CounterPersistence.read()` needs.
 */
import { PersistentEphemeralCounterStore, type CounterPersistence, type CounterSnapshot } from "@kakure/sdk";

const PREFIX = "kakure:eph-counters:";

export function webStorageCounterPersistence(scopeId: string, storage: Storage = localStorage): CounterPersistence {
  const key = PREFIX + scopeId;
  const read = (): CounterSnapshot => {
    const raw = storage.getItem(key);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0),
      ) as CounterSnapshot;
    } catch {
      return {};
    }
  };
  return {
    read,
    async reserve(scope, span) {
      const snapshot = read();
      const base = snapshot[scope] ?? 0;
      snapshot[scope] = base + span;
      storage.setItem(key, JSON.stringify(snapshot));
      return base;
    },
  };
}

export function browserEphemeralCounterStore(scopeId: string, storage?: Storage): PersistentEphemeralCounterStore {
  return new PersistentEphemeralCounterStore(webStorageCounterPersistence(scopeId, storage));
}
