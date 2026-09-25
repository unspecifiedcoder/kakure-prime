import { ComplianceKeyRing } from "@kakure/sdk";
import type { Point } from "@zk-kit/baby-jubjub";

interface ComplianceEpochResponse {
  version: number;
  x: string;
  y: string;
  from_slot?: number;
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
}

/** `GET /compliance` (I-8) -> a `ComplianceKeyRing` covering every epoch the pool has ever used, so the
 *  scanner can open notes minted before a rotation as well as after it. */
/** Where to read the *current* compliance key when the indexer has no epochs yet: a fresh pool's
 *  `initialize` sets the key without emitting a rotation event, so `/compliance` is empty until the
 *  first rotation. The Pool account is authoritative for the current key. */
export interface ComplianceFallback {
  rpcUrl: string;
  programId: string;
}

async function ringFromPoolAccount(fb: ComplianceFallback): Promise<ComplianceKeyRing> {
  const [{ Connection, PublicKey }, { poolPda, decodePool }] = await Promise.all([
    import("@solana/web3.js"),
    import("@kakure/sdk/solana"),
  ]);
  const programId = new PublicKey(fb.programId);
  const [poolAddress] = poolPda(programId);
  const info = await new Connection(fb.rpcUrl).getAccountInfo(poolAddress);
  if (!info) throw new Error("fetchComplianceRing: pool account not found on-chain");
  const pool = decodePool(info.data);
  const be = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));
  return ComplianceKeyRing.from([
    { version: pool.complianceVersion, pk: [be(pool.compliancePkX), be(pool.compliancePkY)] as Point<bigint> },
  ]);
}

export async function fetchComplianceRing(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  fallback?: ComplianceFallback,
): Promise<ComplianceKeyRing> {
  const res = await fetchFn(`${baseUrl}/compliance`);
  if (!res.ok) {
    throw new Error(`fetchComplianceRing: GET /compliance -> HTTP ${res.status}`);
  }
  const epochs = (await res.json()) as ComplianceEpochResponse[];
  if (epochs.length === 0) {
    if (fallback) return ringFromPoolAccount(fallback);
    throw new Error("fetchComplianceRing: indexer returned no compliance key epochs");
  }
  return ComplianceKeyRing.from(
    epochs.map((e) => ({
      version: e.version,
      pk: [hexToBigInt(e.x), hexToBigInt(e.y)] as Point<bigint>,
      ...(e.from_slot !== undefined ? { fromBlock: e.from_slot } : {}),
    })),
  );
}
