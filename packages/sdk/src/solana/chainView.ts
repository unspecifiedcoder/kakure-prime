import { Fr } from "@aztec/foundation/fields";
import { Point } from "@zk-kit/baby-jubjub";
import type { ChainView } from "../tx/ports.js";

// I-8: GET /root -> {root, next_leaf_index, roots: string[256]}
//      GET /compliance -> [{version, x, y, from_slot}]
interface RootResponse {
  root: string;
  next_leaf_index: number;
  roots: string[];
}
interface ComplianceEpoch {
  version: number;
  x: string;
  y: string;
  from_slot: number;
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex.startsWith("0x") ? hex : "0x" + hex);
}

/** `ChainView` (I-`tx/ports.ts`) implemented over the indexer's HTTP API (I-8). Read-only: assembly needs
 *  to know the ring's known roots, the current compliance key, and the next leaf index, and nothing else
 *  (see `ChainView`'s own doc comment on why it stays this narrow). */
export class IndexerClient implements ChainView {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async isKnownRoot(root: Fr): Promise<boolean> {
    const res = await this.fetchFn(`${this.baseUrl}/root`);
    if (!res.ok) {
      throw new Error(`IndexerClient.isKnownRoot: GET /root -> HTTP ${res.status}`);
    }
    const body = (await res.json()) as RootResponse;
    const target = root.toBigInt();
    return body.roots.some((r) => hexToBigInt(r) === target);
  }

  async complianceKey(): Promise<{
    readonly point: Point<bigint>;
    readonly version: number;
  }> {
    const res = await this.fetchFn(`${this.baseUrl}/compliance`);
    if (!res.ok) {
      throw new Error(
        `IndexerClient.complianceKey: GET /compliance -> HTTP ${res.status}`,
      );
    }
    const epochs = (await res.json()) as ComplianceEpoch[];
    if (epochs.length === 0) {
      throw new Error("IndexerClient.complianceKey: indexer returned no compliance key epochs");
    }
    const latest = epochs.reduce((a, b) => (b.version > a.version ? b : a));
    return {
      point: [hexToBigInt(latest.x), hexToBigInt(latest.y)] as Point<bigint>,
      version: latest.version,
    };
  }

  async nextLeafIndex(): Promise<number> {
    const res = await this.fetchFn(`${this.baseUrl}/root`);
    if (!res.ok) {
      throw new Error(`IndexerClient.nextLeafIndex: GET /root -> HTTP ${res.status}`);
    }
    const body = (await res.json()) as RootResponse;
    return body.next_leaf_index;
  }
}
