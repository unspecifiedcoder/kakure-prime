import { useMemo, useState } from "react";
import { RootHeader } from "../components/RootHeader.js";
import { AssetTable, useAssetMap } from "../components/AssetTable.js";
import { BalancesView, type Balance } from "../components/BalancesView.js";
import { NoteHistory, type HistoryNote } from "../components/NoteHistory.js";
import { scanSingleKey } from "../lib/singleKeyScan.js";
import { scanMultisigGroup } from "../lib/multisigScan.js";

type Mode = "single" | "multisig";
type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done" };

/**
 * Spec §1.3 Accountant view. Paste a SCOPED VIEW KEY (single account) or a group's view config —
 * both read-only. Decrypts entirely in the browser. Deliberately has NO field anywhere for a spend
 * key, a FROST key share, or any signing key: every value here is derivable from a view secret
 * alone, and the app never asks for anything else (tested in AuditPage.test.tsx).
 */
export function AuditPage(): JSX.Element {
  const [mode, setMode] = useState<Mode>("single");
  const [indexerUrl, setIndexerUrl] = useState("http://127.0.0.1:8788");
  const [viewKeyHex, setViewKeyHex] = useState("");
  const [groupV, setGroupV] = useState("");
  const [groupGpkX, setGroupGpkX] = useState("");
  const [groupGpkY, setGroupGpkY] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState("");

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [balances, setBalances] = useState<readonly Balance[]>([]);
  const [historyNotes, setHistoryNotes] = useState<readonly HistoryNote[]>([]);
  const [assetMap, setAssetMap] = useAssetMap();

  const knownAssetIds = useMemo(() => historyNotes.map((n) => n.assetId), [historyNotes]);

  async function loadLedger(): Promise<void> {
    setStatus({ kind: "loading" });
    try {
      if (mode === "single") {
        const result = await scanSingleKey(indexerUrl, viewKeyHex);
        setBalances(result.balances);
        setHistoryNotes(
          result.notes.map((n) => ({
            leafIndex: n.leafIndex,
            assetId: `0x${n.note.assetId.toBigInt().toString(16).padStart(40, "0")}`,
            value: n.note.value,
            nullifierHex: n.nullifier.toString(),
            isIncoming: n.isIncoming,
          })),
        );
      } else {
        const result = await scanMultisigGroup(indexerUrl, {
          v: groupV,
          gpkX: groupGpkX,
          gpkY: groupGpkY,
          memberIds: groupMemberIds
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
        setBalances(result.balances);
        setHistoryNotes(
          result.notes.map((n) => ({
            leafIndex: n.leafIndex,
            assetId: `0x${n.note.assetId.toBigInt().toString(16).padStart(40, "0")}`,
            value: n.note.value,
            nullifierHex: n.nullifierHex,
            isIncoming: n.isIncoming,
          })),
        );
      }
      setStatus({ kind: "done" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function downloadCsv(): void {
    const header = "date_or_leaf_index,direction,amount,asset,nullifier\n";
    const rows = historyNotes
      .map((n) => [n.leafIndex, n.isIncoming ? "in" : "out", n.value.toString(), n.assetId, n.nullifierHex].join(","))
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kakure-ledger.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <div className="block hero">
        <span className="badge private">Read-only</span>
        <h1>Ledger (view-only)</h1>
        <p className="lede">Paste the key your treasury exported for you. It can read payments in its range; it cannot move funds. Export the ledger as CSV for your books.</p>
      </div>
      <p>Paste a view key someone gave you to see payments — you can never move money from here.</p>

      <section aria-label="Load ledger">
        <div role="tablist">
          <button type="button" role="tab" aria-selected={mode === "single"} onClick={() => setMode("single")}>
            Personal view key
          </button>
          <button type="button" role="tab" aria-selected={mode === "multisig"} onClick={() => setMode("multisig")}>
            Treasury view key
          </button>
        </div>

        <div>
          <label htmlFor="audit-indexer-url">Indexer URL</label>
          <input id="audit-indexer-url" value={indexerUrl} onChange={(e) => setIndexerUrl(e.target.value)} />
        </div>

        {mode === "single" ? (
          <div>
            <label htmlFor="audit-view-key">View key</label>
            <input id="audit-view-key" value={viewKeyHex} onChange={(e) => setViewKeyHex(e.target.value)} />
          </div>
        ) : (
          <div>
            <label htmlFor="audit-group-v">Treasury view secret</label>
            <input id="audit-group-v" value={groupV} onChange={(e) => setGroupV(e.target.value)} />
            <label htmlFor="audit-group-gpk-x">Treasury public key (x)</label>
            <input id="audit-group-gpk-x" value={groupGpkX} onChange={(e) => setGroupGpkX(e.target.value)} />
            <label htmlFor="audit-group-gpk-y">Treasury public key (y)</label>
            <input id="audit-group-gpk-y" value={groupGpkY} onChange={(e) => setGroupGpkY(e.target.value)} />
            <label htmlFor="audit-group-member-ids">Signer ids (comma-separated)</label>
            <input id="audit-group-member-ids" value={groupMemberIds} onChange={(e) => setGroupMemberIds(e.target.value)} />
          </div>
        )}

        <button type="button" onClick={() => void loadLedger()}>
          Load ledger
        </button>
        {status.kind === "loading" && <p>Loading…</p>}
        {status.kind === "error" && <p role="alert">{status.message}</p>}
      </section>

      {status.kind === "done" && (
        <>
          <RootHeader indexerUrl={indexerUrl} />
          <AssetTable assetMap={assetMap} onChange={setAssetMap} knownAssetIds={knownAssetIds} />
          <BalancesView balances={balances} assetMap={assetMap} />
          <NoteHistory notes={historyNotes} assetMap={assetMap} indexerUrl={indexerUrl} />
          <button type="button" onClick={downloadCsv}>
            Export CSV
          </button>
        </>
      )}
    </main>
  );
}
