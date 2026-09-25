import { useEffect, useState } from "react";
import { isNullifierSpent } from "../lib/rootInfo.js";
import type { AssetMap } from "./AssetTable.js";

export interface HistoryNote {
  leafIndex: number;
  assetId: string;
  value: bigint;
  nullifierHex: string;
  isIncoming: boolean;
}

export interface NoteHistoryProps {
  notes: readonly HistoryNote[];
  assetMap: AssetMap;
  indexerUrl: string;
  fetchFn?: typeof fetch;
}

/** Note history: leaf index, asset, value, and spent/unspent looked up per-note against `GET
 *  /nullifiers/:hex` (I-8) -- the wallet-side `spent` flag from the scanner only reflects notes THIS
 *  scan already recognised as inputs to another note it also found, not the chain's authoritative view. */
export function NoteHistory({ notes, assetMap, indexerUrl, fetchFn = fetch }: NoteHistoryProps): JSX.Element {
  const [spent, setSpent] = useState<Record<string, boolean | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    for (const note of notes) {
      isNullifierSpent(indexerUrl, note.nullifierHex, fetchFn)
        .then((isSpent) => {
          if (!cancelled) setSpent((prev) => ({ ...prev, [note.nullifierHex]: isSpent }));
        })
        .catch(() => {
          if (!cancelled) setSpent((prev) => ({ ...prev, [note.nullifierHex]: undefined }));
        });
    }
    return () => {
      cancelled = true;
    };
    // notes/indexerUrl identity changes drive a re-check; fetchFn is test-only.
  }, [notes, indexerUrl, fetchFn]);

  return (
    <section aria-label="Note history">
      <h2>Note history</h2>
      <table>
        <thead>
          <tr>
            <th>leaf index</th>
            <th>asset</th>
            <th>value</th>
            <th>direction</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((note) => {
            const isSpent = spent[note.nullifierHex];
            return (
              <tr key={`${note.leafIndex}-${note.nullifierHex}`}>
                <td>{note.leafIndex}</td>
                <td>{assetMap[note.assetId] ?? note.assetId}</td>
                <td>{note.value.toString()}</td>
                <td>{note.isIncoming ? "incoming" : "self"}</td>
                <td>{isSpent === undefined ? "checking..." : isSpent ? "spent" : "unspent"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
