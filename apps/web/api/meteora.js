const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const EVIDENCE = {
  network: "devnet",
  config: "8wqCNyoxQMUGRJwXngG2wxVLzqduTazi2nDjcuoCqbFT",
  pool: "58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW",
  receiptMint: "Eqi8f5wf2fDWKriZUGC8qRS9ueYwhf37LDpZupaSbfJ8",
  configSignature: "2f12VxbqsTogybhARtUddxmVdKstxFu67QJHNvqr5QLS97Qcc6FEqofvPsV8cFa7wThUuN2qegDVeRAe6LPbMFkE",
  poolSignature: "4dLKSKqFAwAemaXXwAveqmiWVLiKDdbW8K1pZ8w3beYQSHFasqH2FTgkwSrmxvEqRmbfyFBnhWigF9cADTfmt8mY",
  tradeSignature: "57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to",
  quoteReserveLamports: 19_800_000,
  curveProgress: 0.008241309768918573,
  feeStartBps: 100,
  feeEndBps: 25,
  graduation: "DAMM v2",
};

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message ?? "Solana RPC error");
  return payload.result;
}

export default async function handler(_request, response) {
  try {
    const [accounts, statuses] = await Promise.all([
      rpc("getMultipleAccounts", [[EVIDENCE.config, EVIDENCE.pool, EVIDENCE.receiptMint], { encoding: "base64", commitment: "confirmed" }]),
      rpc("getSignatureStatuses", [[EVIDENCE.configSignature, EVIDENCE.poolSignature, EVIDENCE.tradeSignature], { searchTransactionHistory: true }]),
    ]);
    const owners = accounts.value.map((account) => account?.owner ?? null);
    const finalized = statuses.value.every((status) => status && status.err === null && ["confirmed", "finalized"].includes(status.confirmationStatus));
    const verified = owners[0] === DBC_PROGRAM && owners[1] === DBC_PROGRAM && owners[2] === TOKEN_PROGRAM && finalized;
    response.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    response.status(200).json({ ...EVIDENCE, verified, owners, finalized });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Meteora evidence unavailable" });
  }
}
