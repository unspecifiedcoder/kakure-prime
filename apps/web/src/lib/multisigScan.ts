import { Fr, MultisigScanEngine, httpNotesTransport } from "@kakure/sdk";
import type { Point } from "@zk-kit/baby-jubjub";
import { fetchComplianceRing } from "./complianceRing.js";
import type { MultisigNoteView } from "@kakure/sdk/frost";

/** What the user pastes to view a multisig group's notes: the group's shared view secret and public
 *  key, plus the member ids the group was set up with. None of this is spend authority -- `v`/`gpk` open
 *  notes for reading; only a FROST quorum of the members' individual key shares can spend. */
export interface MultisigGroupConfigInput {
  readonly v: string; // hex/decimal Fr: the shared group view secret
  readonly gpkX: string;
  readonly gpkY: string;
  readonly memberIds: readonly string[]; // decimal or hex bigints
}

export interface MultisigBalance {
  assetId: string;
  total: bigint;
}

export interface MultisigScanNote {
  readonly note: { readonly assetId: Fr; readonly value: bigint };
  readonly leafIndex: number;
  readonly isIncoming: boolean;
  readonly nullifierHex: string;
}

export interface MultisigScanResult {
  notes: readonly MultisigScanNote[];
  balances: readonly MultisigBalance[];
}

function parseBigInt(value: string): bigint {
  return BigInt(value.startsWith("0x") ? value : value.match(/^-?\d+$/) ? value : `0x${value}`);
}

function toHexAssetId(assetId: Fr): string {
  return `0x${assetId.toBigInt().toString(16).padStart(40, "0")}`;
}

/** The dashboard's multisig read path: a pasted group view config in, notes + per-asset balances out.
 *  Delegates to `@kakure/sdk`'s `MultisigScanEngine` (which wraps the already-tested `MultisigScanner`) --
 *  this module only adapts a hex/string config into the `Fr`/`Point` shapes it expects and fetches the
 *  compliance key ring the group's notes were minted against. */
/** The raw scanner views (`MultisigNoteView`: full note fields, commitment, leaf index,
 *  nullifier) -- what `treasuryFlows.payOneRecipient` must be fed as its `sourceNote`. The slimmed
 *  `scanMultisigGroup` rows below are for display only and are NOT usable as a spend input. */
export async function scanMultisigGroupViews(
  indexerBaseUrl: string,
  config: MultisigGroupConfigInput,
  fetchFn: typeof fetch = fetch,
): Promise<MultisigNoteView[]> {
  const v = new Fr(parseBigInt(config.v));
  const gpk: Point<bigint> = [parseBigInt(config.gpkX), parseBigInt(config.gpkY)];
  const memberIds = config.memberIds.map(parseBigInt);
  const compliancePk = await fetchComplianceRing(indexerBaseUrl, fetchFn);

  const engine = await MultisigScanEngine.create(httpNotesTransport(indexerBaseUrl, fetchFn), {
    v,
    gpk,
    compliancePk,
    memberIds,
  });
  return engine.sync(0);
}

export async function scanMultisigGroup(
  indexerBaseUrl: string,
  config: MultisigGroupConfigInput,
  fetchFn: typeof fetch = fetch,
): Promise<MultisigScanResult> {
  const found = await scanMultisigGroupViews(indexerBaseUrl, config, fetchFn);

  const totals = new Map<string, bigint>();
  for (const view of found) {
    const key = toHexAssetId(view.note.assetId);
    totals.set(key, (totals.get(key) ?? 0n) + view.note.value);
  }
  return {
    notes: found.map((v2) => ({
      note: { assetId: v2.note.assetId, value: v2.note.value },
      leafIndex: v2.leafIndex,
      isIncoming: v2.isIncoming,
      nullifierHex: `0x${v2.nullifier.toBigInt().toString(16).padStart(64, "0")}`,
    })),
    balances: Array.from(totals.entries()).map(([assetId, total]) => ({ assetId, total })),
  };
}
