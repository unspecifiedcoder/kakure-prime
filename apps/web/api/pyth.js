const CATALOG_URL = "https://hermes.pyth.network/v2/price_feeds?query=AAPL";
const PRICE_URL = "https://pyth.dourolabs.app/hermes/v2/updates/price/latest";
const SYMBOL = "Crypto.AAPLX/USD";

export default async function handler(_request, response) {
  try {
    const catalogResponse = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
    if (!catalogResponse.ok) throw new Error(`Pyth catalog returned ${catalogResponse.status}`);
    const feeds = await catalogResponse.json();
    const feed = feeds.find((candidate) => candidate?.attributes?.symbol === SYMBOL);
    if (!feed?.id || typeof feed?.market_hours?.is_open !== "boolean") {
      response.status(502).json({ error: "Canonical AAPLx feed unavailable" });
      return;
    }

    const result = {
      symbol: SYMBOL,
      feedId: feed.id,
      isOpen: feed.market_hours.is_open,
      nextOpen: feed.market_hours.next_open ?? null,
      nextClose: feed.market_hours.next_close ?? null,
      price: null,
      confidence: null,
      publishTime: null,
      mode: "catalog",
    };

    const apiKey = process.env.PYTH_API_KEY;
    if (apiKey) {
      const query = new URLSearchParams();
      query.append("ids[]", feed.id);
      const priceResponse = await fetch(`${PRICE_URL}?${query}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      if (!priceResponse.ok) throw new Error(`Pyth price service returned ${priceResponse.status}`);
      const payload = await priceResponse.json();
      const update = payload.parsed?.find((candidate) => candidate?.id === feed.id);
      const price = update?.price;
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
