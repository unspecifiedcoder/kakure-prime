export interface PreStock {
  readonly name: string;
  readonly symbol: string;
  readonly contractAddress: string;
  readonly markPrice: number;
  readonly tokenPrice: number;
  readonly onChainVerified: boolean;
  readonly tokenProgram: string | null;
}

export interface PythMarketStatus {
  readonly symbol: string;
  readonly feedId: string;
  readonly isOpen: boolean;
  readonly nextOpen: number | null;
  readonly nextClose: number | null;
  readonly price: number | null;
  readonly confidence: number | null;
  readonly publishTime: number | null;
  readonly mode: "catalog" | "price";
}

export interface MeteoraEvidence {
  readonly network: "devnet";
  readonly config: string;
  readonly pool: string;
  readonly receiptMint: string;
  readonly tradeSignature: string;
  readonly quoteReserveLamports: number;
  readonly curveProgress: number;
  readonly feeStartBps: number;
  readonly feeEndBps: number;
  readonly graduation: string;
  readonly verified: boolean;
  readonly finalized: boolean;
}

interface PreStocksApiRow {
  name?: unknown;
  symbol?: unknown;
  contract_address?: unknown;
  markPrice?: unknown;
  tokenPrice?: unknown;
  onChainVerified?: unknown;
  tokenProgram?: unknown;
}

export const PRESTOCKS_API = "/api/prestocks";
export const PYTH_FEEDS_API = "/api/pyth";
export const METEORA_EVIDENCE_API = "/api/meteora";

export async function fetchPreStocks(signal?: AbortSignal): Promise<PreStock[]> {
  const response = await fetch(PRESTOCKS_API, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`PreStocks API returned ${response.status}`);
  const rows = (await response.json()) as PreStocksApiRow[];
  return rows.flatMap((row) =>
    typeof row.name === "string" &&
    typeof row.symbol === "string" &&
    typeof row.contract_address === "string" &&
    typeof row.markPrice === "number" &&
    typeof row.tokenPrice === "number" &&
    typeof row.onChainVerified === "boolean"
      ? [{ name: row.name, symbol: row.symbol, contractAddress: row.contract_address, markPrice: row.markPrice, tokenPrice: row.tokenPrice, onChainVerified: row.onChainVerified, tokenProgram: typeof row.tokenProgram === "string" ? row.tokenProgram : null }]
      : [],
  );
}

export async function fetchPythAaplStatus(signal?: AbortSignal): Promise<PythMarketStatus> {
  const response = await fetch(PYTH_FEEDS_API, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Pyth feed catalog returned ${response.status}`);
  const row = (await response.json()) as Partial<PythMarketStatus>;
  if (row.symbol !== "Crypto.AAPLX/USD" || typeof row.feedId !== "string" || typeof row.isOpen !== "boolean") {
    throw new Error("Pyth AAPLx feed was not available");
  }
  return {
    symbol: row.symbol,
    feedId: row.feedId,
    isOpen: row.isOpen,
    nextOpen: typeof row.nextOpen === "number" ? row.nextOpen : null,
    nextClose: typeof row.nextClose === "number" ? row.nextClose : null,
    price: typeof row.price === "number" ? row.price : null,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    publishTime: typeof row.publishTime === "number" ? row.publishTime : null,
    mode: row.mode === "price" ? "price" : "catalog",
  };
}

export async function fetchMeteoraEvidence(signal?: AbortSignal): Promise<MeteoraEvidence> {
  const response = await fetch(METEORA_EVIDENCE_API, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Meteora evidence API returned ${response.status}`);
  const row = (await response.json()) as Partial<MeteoraEvidence>;
  if (typeof row.pool !== "string" || typeof row.tradeSignature !== "string" || typeof row.verified !== "boolean") {
    throw new Error("Meteora evidence was malformed");
  }
  return row as MeteoraEvidence;
}

export function navPremium(stock: Pick<PreStock, "markPrice" | "tokenPrice">): number {
  return ((stock.tokenPrice - stock.markPrice) / stock.markPrice) * 100;
}

export function preStockRisk(stock: PreStock): { readonly passed: boolean; readonly reason: string } {
  const premium = Math.abs(navPremium(stock));
  const officialAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(stock.contractAddress) && stock.onChainVerified;
  return {
    passed: officialAddress && premium <= 15,
    reason: !officialAddress ? "unverified contract" : premium > 15 ? "premium outside 15% mandate" : "official asset · NAV guard passed",
  };
}

export function pythRisk(status: PythMarketStatus, nowSeconds = Math.floor(Date.now() / 1000)): {
  readonly passed: boolean;
  readonly confidenceBps: number | null;
  readonly ageSeconds: number | null;
  readonly reason: string;
} {
  if (status.price === null || status.confidence === null || status.publishTime === null) {
    return { passed: false, confidenceBps: null, ageSeconds: null, reason: "Pyth Pro price broker awaiting API key" };
  }
  const ageSeconds = Math.max(0, nowSeconds - status.publishTime);
  const confidenceBps = status.price === 0 ? Number.POSITIVE_INFINITY : (status.confidence / Math.abs(status.price)) * 10_000;
  const passed = status.isOpen && ageSeconds <= 30 && confidenceBps <= 100;
  return { passed, confidenceBps, ageSeconds, reason: passed ? "fresh price · confidence guard passed" : "price risk gate blocked settlement" };
}
