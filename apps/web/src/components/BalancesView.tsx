import type { AssetMap } from "./AssetTable.js";

export interface Balance {
  assetId: string;
  total: bigint;
}

export interface BalancesViewProps {
  balances: readonly Balance[];
  assetMap: AssetMap;
}

/** Per-asset balances, grouped by `asset_id`, labelled with the user's asset table entry (falling back to
 *  the bare asset_id when no label has been set). */
export function BalancesView({ balances, assetMap }: BalancesViewProps): JSX.Element {
  return (
    <section aria-label="Balances">
      <h2>Balances</h2>
      {balances.length === 0 ? (
        <p>No balances found.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>asset</th>
              <th>balance</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.assetId}>
                <td>{assetMap[b.assetId] ?? b.assetId}</td>
                <td>{b.total.toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
