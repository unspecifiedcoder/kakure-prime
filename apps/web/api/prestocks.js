export default async function handler(_request, response) {
  try {
    const upstream = await fetch("https://prestocks.com/api/prestocks", {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      response.status(upstream.status).json({ error: "PreStocks upstream unavailable" });
      return;
    }
    const body = await upstream.json();
    response.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    response.status(200).json(body);
  } catch {
    response.status(502).json({ error: "PreStocks upstream unavailable" });
  }
}
