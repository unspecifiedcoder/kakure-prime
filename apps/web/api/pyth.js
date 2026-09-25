const CATALOG_URL = "https://hermes.pyth.network/v2/price_feeds";
const PRICE_URL = "https://pyth.dourolabs.app/hermes/v2/updates/price/latest";
const PRIMARY_SYMBOL = "Crypto.AAPLX/USD";
const FALLBACK_SYMBOL = "Crypto.SOL/USD";

async function catalog(query) {
  const response = await fetch(`${CATALOG_URL}?query=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Pyth catalog returned ${response.status}`);
  return response.json();
}

async function latest(feed, apiKey) {
  const query = new URLSearchParams();
  query.append("ids[]", feed.id);
  const response = await fetch(`${PRICE_URL}?${query}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { status: response.status, update: null };
  const payload = await response.json();
  return { status: response.status, update: payload.parsed?.find((candidate) => candidate?.id === feed.id) ?? null };
}

export default async function handler(_request, response) {
  try {
    const [aaplFeeds, solFeeds] = await Promise.all([catalog("AAPL"), catalog("SOL/USD")]);
    const primaryFeed = aaplFeeds.find((candidate) => candidate?.attributes?.symbol === PRIMARY_SYMBOL);
    const fallbackFeed = solFeeds.find((candidate) => candidate?.attributes?.symbol === FALLBACK_SYMBOL);
    if (!primaryFeed?.id || typeof primaryFeed?.market_hours?.is_open !== "boolean" || !fallbackFeed?.id) {
      response.status(502).json({ error: "Canonical Pyth settlement feeds unavailable" });
      return;
    }

    const result = {
      symbol: PRIMARY_SYMBOL,
      requestedSymbol: PRIMARY_SYMBOL,
      feedId: primaryFeed.id,
      isOpen: primaryFeed.market_hours.is_open,
      nextOpen: primaryFeed.market_hours.next_open ?? null,
      nextClose: primaryFeed.market_hours.next_close ?? null,
      price: null,
      confidence: null,
      publishTime: null,
      mode: "catalog",
      useCase: "tokenized-equity price gate",
    };

    const apiKey = process.env.PYTH_API_KEY;
    if (apiKey) {
      let priceResult = await latest(primaryFeed, apiKey);
      if (priceResult.status === 403) {
        priceResult = await latest(fallbackFeed, apiKey);
        result.symbol = FALLBACK_SYMBOL;
        result.feedId = fallbackFeed.id;
        result.isOpen = fallbackFeed.market_hours?.is_open ?? true;
        result.nextOpen = fallbackFeed.market_hours?.next_open ?? null;
        result.nextClose = fallbackFeed.market_hours?.next_close ?? null;
        result.useCase = "SOL collateral-health gate for equity settlement";
      }
      if (priceResult.status !== 200) throw new Error(`Pyth price service returned ${priceResult.status}`);
      const price = priceResult.update?.price;
      if (!price || typeof price.price !== "string" || typeof price.conf !== "string" || typeof price.expo !== "number") {
        throw new Error("Pyth price response was malformed");
      }
      const scale = 10 ** price.expo;
      result.price = Number(price.price) * scale;
      result.confidence = Number(price.conf) * scale;
      result.publishTime = price.publish_time;
      result.mode = "price";
    }

    response.setHeader("Cache-Control", "s-maxage=2, stale-while-revalidate=8");
    response.status(200).json(result);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Pyth unavailable" });
  }
}
