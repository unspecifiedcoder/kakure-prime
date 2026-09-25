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
    const addresses = body.map((row) => row.contract_address).filter((address) => typeof address === "string");
    const rpcResponse = await fetch(process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [addresses, { encoding: "base64", commitment: "confirmed" }],
      }),
    });
    const rpcPayload = rpcResponse.ok ? await rpcResponse.json() : null;
    const accounts = rpcPayload?.result?.value ?? [];
    const enriched = body.map((row, index) => ({
      ...row,
      onChainVerified: accounts[index]?.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      tokenProgram: accounts[index]?.owner ?? null,
    }));
    response.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    response.status(200).json(enriched);
  } catch {
    response.status(502).json({ error: "PreStocks upstream unavailable" });
  }
}
