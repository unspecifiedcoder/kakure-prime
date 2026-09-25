/**
 * `kakure balance`: multisig note scanning over the indexer (I-8), via `@kakure/sdk`'s
 * `MultisigScanEngine` + `MultisigScanner` (self-contained: unlike the single-key `ScanEngine`,
 * it needs no `IKeyRepository`/`IUtxoRepository` -- see the workstream report's "changes needed
 * in sdk" note about those interfaces not being part of the public barrel).
 */
import { Fr, MultisigScanEngine, httpNotesTransport } from "@kakure/sdk";
import { pointFromHex } from "../dkg/pointHex.js";
import type { GroupRecord } from "./group.js";

export interface BalanceRow {
  assetId: string;
  total: bigint;
  noteCount: number;
}

interface ComplianceEpoch {
  version: number;
  x: string;
  y: string;
  from_slot: number;
}

async function fetchLatestCompliance(indexerUrl: string): Promise<{ x: string; y: string }> {
  const res = await fetch(`${indexerUrl}/compliance`);
  if (!res.ok) throw new Error(`balance: GET /compliance -> HTTP ${res.status}`);
  const epochs = (await res.json()) as ComplianceEpoch[];
  if (epochs.length === 0) throw new Error("balance: indexer returned no compliance key epochs");
  return epochs.reduce((a, b) => (b.version > a.version ? b : a));
}

/**
 * slice-2 F-5: ALL spent nullifiers since `fromSlot`, in one request -- membership is then
 * checked locally. Before this, `computeBalance` issued one `GET /nullifiers/:hex` per UNSPENT
 * note the group owns, which lets the indexer operator learn a wallet's exact note set before any
 * of it is even spent (and later link the spend once the same nullifier is queried again). The
 * spent set is public on-chain anyway, so fetching it in bulk is not a new information leak.
 */
async function fetchSpentNullifiers(indexerUrl: string, fromSlot = 0): Promise<Set<string>> {
  const res = await fetch(`${indexerUrl}/nullifiers?from_slot=${fromSlot}`);
  if (!res.ok) throw new Error(`balance: GET /nullifiers?from_slot=${fromSlot} -> HTTP ${res.status}`);
  const body = (await res.json()) as { nullifiers: string[] };
  return new Set(body.nullifiers.map((n) => n.toLowerCase()));
}

export async function computeBalance(indexerUrl: string, group: GroupRecord): Promise<BalanceRow[]> {
  const compliance = await fetchLatestCompliance(indexerUrl);
  const engine = await MultisigScanEngine.create(httpNotesTransport(indexerUrl), {
    v: new Fr(BigInt(group.groupViewKey.v)),
    gpk: [...pointFromHex(group.gpk)],
    compliancePk: [BigInt(compliance.x), BigInt(compliance.y)],
    memberIds: group.participantIds.map((id) => BigInt(id)),
  });

  const [views, spent] = await Promise.all([engine.sync(0), fetchSpentNullifiers(indexerUrl)]);
  const totals = new Map<string, { total: bigint; count: number }>();
  for (const view of views) {
    const nullifierHex = "0x" + view.nullifier.toString().replace(/^0x/, "").padStart(64, "0");
    if (spent.has(nullifierHex.toLowerCase())) continue;
    const assetKey = view.note.assetId.toString();
    const entry = totals.get(assetKey) ?? { total: 0n, count: 0 };
    entry.total += view.note.value;
    entry.count += 1;
    totals.set(assetKey, entry);
  }
  return [...totals.entries()].map(([assetId, { total, count }]) => ({
    assetId,
    total,
    noteCount: count,
  }));
}
