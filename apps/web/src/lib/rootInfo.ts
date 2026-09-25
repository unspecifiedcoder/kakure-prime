export interface RootInfo {
  root: string;
  nextLeafIndex: number;
}

/** `GET /root` (I-8). */
export async function fetchRootInfo(
  indexerBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<RootInfo> {
  const res = await fetchFn(`${indexerBaseUrl}/root`);
  if (!res.ok) {
    throw new Error(`fetchRootInfo: GET /root -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { root: string; next_leaf_index: number };
  return { root: body.root, nextLeafIndex: body.next_leaf_index };
}

/** `GET /nullifiers/:hex` (I-8). */
export async function isNullifierSpent(
  indexerBaseUrl: string,
  nullifierHex: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const hex = nullifierHex.startsWith("0x") ? nullifierHex.slice(2) : nullifierHex;
  const res = await fetchFn(`${indexerBaseUrl}/nullifiers/${hex}`);
  if (!res.ok) {
    throw new Error(`isNullifierSpent: GET /nullifiers/${hex} -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { spent: boolean };
  return body.spent;
}
