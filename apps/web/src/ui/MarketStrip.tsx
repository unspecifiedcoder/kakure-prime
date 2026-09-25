import { useEffect, useState } from "react";
import { KNOWN_TOKENS } from "./tokens.js";

type QuoteState = Record<string, number>;

const EQUITIES = KNOWN_TOKENS.filter((token) => token.kind === "equity" || token.kind === "etf");
const REFERENCE_QUOTES: QuoteState = { AAPLx: 339.9, TSLAx: 372.68, NVDAx: 224.86, SPYx: 770.64 };

export function MarketStrip(): JSX.Element {
  const [quotes, setQuotes] = useState<QuoteState>(REFERENCE_QUOTES);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      EQUITIES.map(async (asset) => {
        const response = await fetch(`https://api.xstocks.fi/api/v2/public/assets/${asset.symbol}/price-data`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`quote ${response.status}`);
        const body = (await response.json()) as { quote?: number };
        return [asset.symbol, body.quote] as const;
      }),
    )
      .then((rows) => {
        const next: QuoteState = {};
        for (const [symbol, quote] of rows) if (typeof quote === "number") next[symbol] = quote;
        setQuotes(next);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return (
    <section className="market-strip" aria-label="Supported tokenized equities">
      <div className="market-strip-head">
        <span>Shieldable on Solana</span>
        <span className="live-dot">xStocks reference · Sep 25</span>
      </div>
      <div className="market-grid">
        {EQUITIES.map((asset) => (
          <article className="market-asset" key={asset.mint}>
            <span className="ticker">{asset.symbol}</span>
            <strong>{quotes[asset.symbol] === undefined ? "—" : `$${quotes[asset.symbol]!.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</strong>
            <span>{asset.name}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
