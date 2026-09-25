import {
  foldPath,
  WitnessSourceError,
  type WitnessTransport,
} from "../tx/witnessSources.js";
import type { MerkleWitnessSource } from "../tx/ports.js";

/** I-8: `GET /path/:leaf_index -> {siblings: string[32]}`. Unlike the reference EVM implementation's `IndexerWitnessSource`
 *  (keyed by leaf, since EVM indexers historically only supported that), Kakure's indexer API is keyed by
 *  leaf INDEX -- so this source needs the caller's own leaf-index bookkeeping (a `WalletNote.leafIndex`,
 *  typically) to look one up. It still folds and verifies the returned siblings against the leaf before
 *  returning, same as the reference EVM implementation's version. */
export function indexerTransport(
  baseUrl: string,
  leafIndexOf: (leafHex: string) => number | undefined,
  fetchFn: typeof fetch = fetch,
): WitnessTransport {
  return async (leafHex: string) => {
    const leafIndex = leafIndexOf(leafHex);
    if (leafIndex === undefined) {
      throw new WitnessSourceError(
        "LEAF_NOT_FOUND",
        `no known leaf index for leaf ${leafHex}`,
      );
    }
    const res = await fetchFn(`${baseUrl}/path/${leafIndex}`);
    if (!res.ok) {
      throw new WitnessSourceError(
        "TRANSPORT",
        `indexer /path/${leafIndex} returned HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as { siblings: string[] };
    const rootRes = await fetchFn(`${baseUrl}/root`);
    const rootBody = (await rootRes.json()) as { root: string };
    return { leafIndex, siblings: body.siblings, root: rootBody.root };
  };
}

export { foldPath };
export type { MerkleWitnessSource };
