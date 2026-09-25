/** Display helpers. Amounts on-chain are integers in the token's smallest unit; people read decimals. */
export function formatAmount(raw: bigint, decimals?: number, symbol?: string): string {
  if (decimals === undefined || decimals === 0) return raw.toString() + (symbol ? ` ${symbol}` : "");
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}${symbol ? ` ${symbol}` : ""}`;
}

/** "1,500.25" / "1500.25" in a token with `decimals` -> smallest-unit bigint. Throws on bad input. */
export function parseAmount(text: string, decimals: number): bigint {
  const clean = text.replace(/[,\s_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`"${text}" is not an amount`);
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function shortAddress(s: string, head = 4, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Rough wall-clock guidance for the proving stages, so a wait never looks like a hang. */
export const PROVING_ETA: Record<"loading-pk" | "witness" | "proving", string> = {
  "loading-pk": "~10 s, once per visit",
  witness: "~5 s",
  proving: "30–120 s",
};
