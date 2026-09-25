const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const EVIDENCE = {
  network: "devnet",
  poolProgram: "HPzs68TncDWTHocTZv5ekvpMwDjcx4PeHLoTedwBsccF",
  demoVerifier: "37K2Nhpuh2r3xv6gZ9yfA8gPpEpvDXfLkgkK3YmdWVHT",
  verifierMode: "test-only",
  productionVerifierCount: 7,
  localE2eCommand: "pnpm vitest run e2e/scenario.test.ts",
};

async function rpc(method, params) {
  const result = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!result.ok) throw new Error(`Solana RPC returned ${result.status}`);
  const payload = await result.json();
  if (payload.error) throw new Error(payload.error.message ?? "Solana RPC error");
  return payload.result;
}

export default async function handler(_request, response) {
  try {
    const accounts = await rpc("getMultipleAccounts", [
      [EVIDENCE.poolProgram, EVIDENCE.demoVerifier],
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const programs = accounts.value.map((account) => ({
      executable: account?.executable === true,
      owner: account?.owner ?? null,
    }));
    const verified = programs.every((program) => program.executable && program.owner === UPGRADEABLE_LOADER);
    response.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    response.status(200).json({ ...EVIDENCE, programs, verified });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Protocol evidence unavailable" });
  }
}
