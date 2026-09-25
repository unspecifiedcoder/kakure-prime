import { useEffect, useState } from "react";

export interface AssetMap {
  [assetIdHex: string]: string; // asset_id (hex) -> user label (usually the mint address)
}

const STORAGE_KEY = "kakure.dashboard.assetMap.v1";

export function loadAssetMap(): AssetMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AssetMap) : {};
  } catch {
    return {};
  }
}

function saveAssetMap(map: AssetMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best-effort only: a private window or blocked storage must not crash the dashboard.
  }
}

export interface AssetTableProps {
  assetMap: AssetMap;
  onChange: (next: AssetMap) => void;
  /** Asset ids seen in scanned notes, so a user can label one even before typing it manually. */
  knownAssetIds?: readonly string[];
}

/** User-editable asset_id <-> mint mapping. Nothing here is fetched from chain: the pool's `Asset` PDA
 *  is the authority on this mapping, but the dashboard is read-only and has no RPC client wired in, so a
 *  user who knows which mint an asset_id corresponds to records it here for display purposes only. */
export function AssetTable({ assetMap, onChange, knownAssetIds = [] }: AssetTableProps): JSX.Element {
  const [newAssetId, setNewAssetId] = useState("");
  const [newMint, setNewMint] = useState("");

  const rows = Array.from(
    new Set([...Object.keys(assetMap), ...knownAssetIds]),
  ).sort();

  function setLabel(assetId: string, mint: string): void {
    const next = { ...assetMap, [assetId]: mint };
    onChange(next);
    saveAssetMap(next);
  }

  function removeLabel(assetId: string): void {
    const next = { ...assetMap };
    delete next[assetId];
    onChange(next);
    saveAssetMap(next);
  }

  function addRow(): void {
    if (!newAssetId.trim()) return;
    setLabel(newAssetId.trim(), newMint.trim());
    setNewAssetId("");
    setNewMint("");
  }

  return (
    <section aria-label="Asset table">
      <h2>Assets</h2>
      <table>
        <thead>
          <tr>
            <th>asset_id</th>
            <th>mint label</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((assetId) => (
            <tr key={assetId}>
              <td>{assetId}</td>
              <td>
                <input
                  aria-label={`mint label for ${assetId}`}
                  value={assetMap[assetId] ?? ""}
                  onChange={(e) => setLabel(assetId, e.target.value)}
                />
              </td>
              <td>
                <button type="button" onClick={() => removeLabel(assetId)}>
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <input
          aria-label="new asset id"
          placeholder="asset_id (0x...)"
          value={newAssetId}
          onChange={(e) => setNewAssetId(e.target.value)}
        />
        <input
          aria-label="new mint label"
          placeholder="mint label"
          value={newMint}
          onChange={(e) => setNewMint(e.target.value)}
        />
        <button type="button" onClick={addRow}>
          add
        </button>
      </div>
    </section>
  );
}

export function useAssetMap(): [AssetMap, (next: AssetMap) => void] {
  const [assetMap, setAssetMap] = useState<AssetMap>(() => loadAssetMap());
  useEffect(() => {
    saveAssetMap(assetMap);
  }, [assetMap]);
  return [assetMap, setAssetMap];
}
