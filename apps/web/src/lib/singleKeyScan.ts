import { Fr, httpNotesTransport, ScanEngine } from "@kakure/sdk";
import { ViewOnlyAccount } from "./viewOnlyAccount.js";
import { fetchComplianceRing, type ComplianceFallback } from "./complianceRing.js";
import { ScanOnlyKeyRepository, ScanOnlyUtxoRepository, type ScanOnlyNote } from "./scanOnlyRepositories.js";

export interface AssetBalance {
  assetId: string; // 0x-prefixed hex
  total: bigint;
}

export interface SingleKeyScanResult {
  notes: readonly ScanOnlyNote[];
  balances: readonly AssetBalance[];
}

function toHexAssetId(assetId: Fr): string {
  return `0x${assetId.toBigInt().toString(16).padStart(40, "0")}`;
}

/**
 * The dashboard's single-key read path: view key in, notes + per-asset balances out. Never touches a
 * spend/root secret -- `ViewOnlyAccount` (this directory) derives everything `KeyRepository` needs from
 * the view key alone.
 */
export async function scanSingleKey(
  indexerBaseUrl: string,
  viewKeyHex: string,
  fetchFn: typeof fetch = fetch,
  fallback?: ComplianceFallback,
): Promise<SingleKeyScanResult> {
  const viewKey = new Fr(
    BigInt(viewKeyHex.startsWith("0x") ? viewKeyHex : `0x${viewKeyHex}`),
  );
  const account = ViewOnlyAccount.fromViewKey(viewKey);
  const keyRepo = new ScanOnlyKeyRepository(account);
  const utxoRepo = new ScanOnlyUtxoRepository();
  const compliance = await fetchComplianceRing(indexerBaseUrl, fetchFn, fallback);

  const engine = new ScanEngine(
    httpNotesTransport(indexerBaseUrl, fetchFn),
    keyRepo,
    utxoRepo,
    compliance,
  );
  await engine.sync(0);

  const notes = utxoRepo.getAllNotes();
  const totals = new Map<string, bigint>();
  for (const n of notes) {
    if (n.spent) continue;
    const key = toHexAssetId(n.note.assetId);
    totals.set(key, (totals.get(key) ?? 0n) + n.note.value);
  }
  const balances = Array.from(totals.entries()).map(([assetId, total]) => ({
    assetId,
    total,
  }));
  return { notes, balances };
}
