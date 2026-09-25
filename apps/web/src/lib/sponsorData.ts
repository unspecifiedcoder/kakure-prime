export interface PreStock {
  readonly name: string;
  readonly symbol: string;
  readonly contractAddress: string;
  readonly markPrice: number;
  readonly tokenPrice: number;
}

export interface PythMarketStatus {
  readonly symbol: string;
  readonly feedId: string;
  readonly isOpen: boolean;
  readonly nextOpen: number | null;
  readonly nextClose: number | null;
}

interface PreStocksApiRow {
  name?: unknown;
  symbol?: unknown;
  contract_address?: unknown;
  markPrice?: unknown;
  tokenPrice?: unknown;
}

interface PythFeedRow {
  id?: unknown;
  market_hours?: { is_open?: unknown; next_open?: unknown; next_close?: unknown };
  attributes?: { symbol?: unknown };
}

export const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
export const PYTH_FEEDS_API = "https://hermes.pyth.network/v2/price_feeds?query=AAPL";

export async function fetchPreStocks(signal?: AbortSignal): Promise<PreStock[]> {
  const response = await fetch(PRESTOCKS_API, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`PreStocks API returned ${response.status}`);
  const rows = (await response.json()) as PreStocksApiRow[];
  return rows.flatMap((row) =>
    typeof row.name === "string" &&
    typeof row.symbol === "string" &&
    typeof row.contract_address === "string" &&
    typeof row.markPrice === "number" &&
    typeof row.tokenPrice === "number"
      ? [{ name: row.name, symbol: row.symbol, contractAddress: row.contract_address, markPrice: row.markPrice, tokenPrice: row.tokenPrice }]
      : [],
  );
}

export async function fetchPythAaplStatus(signal?: AbortSignal): Promise<PythMarketStatus> {
  const response = await fetch(PYTH_FEEDS_API, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Pyth feed catalog returned ${response.status}`);
  const rows = (await response.json()) as PythFeedRow[];
  const row = rows.find((candidate) => candidate.attributes?.symbol === "Crypto.AAPLX/USD");
  if (!row || typeof row.id !== "string" || typeof row.market_hours?.is_open !== "boolean") {
    throw new Error("Pyth AAPLx feed was not available");
  }
  return {
    symbol: "Crypto.AAPLX/USD",
    feedId: row.id,
    isOpen: row.market_hours.is_open,
    nextOpen: typeof row.market_hours.next_open === "number" ? row.market_hours.next_open : null,
    nextClose: typeof row.market_hours.next_close === "number" ? row.market_hours.next_close : null,
  };
}

export function navPremium(stock: Pick<PreStock, "markPrice" | "tokenPrice">): number {
  return ((stock.tokenPrice - stock.markPrice) / stock.markPrice) * 100;
}
