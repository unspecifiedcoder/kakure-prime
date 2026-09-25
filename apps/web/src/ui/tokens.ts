import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

export interface TokenInfo {
  mint: string;
  decimals: number;
  symbol: string;
  name?: string;
  kind?: "cash" | "equity" | "etf";
}

/** Well-known mints so the common case never asks anyone to type a mint address. */
export const KNOWN_TOKENS: readonly TokenInfo[] = [
  { mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, symbol: "AAPLx", name: "Apple xStock", kind: "equity" },
  { mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, symbol: "TSLAx", name: "Tesla xStock", kind: "equity" },
  { mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, symbol: "NVDAx", name: "NVIDIA xStock", kind: "equity" },
  { mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, symbol: "SPYx", name: "S&P 500 xStock", kind: "etf" },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC", name: "USD Coin", kind: "cash" },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, symbol: "USDT", name: "Tether USD", kind: "cash" },
  { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, symbol: "USDC (devnet)", name: "USD Coin", kind: "cash" },
];

export function knownToken(mint: string): TokenInfo | undefined {
  return KNOWN_TOKENS.find((t) => t.mint === mint);
}

/** Resolve and pin the program that actually owns a mint. Kakure Prime supports both classic SPL
 *  Token and Token-2022; refusing every other owner keeps the on-chain program substitution check
 *  intact. */
export async function tokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const account = await connection.getAccountInfo(mint);
  if (!account) throw new Error(`mint ${mint.toBase58()} was not found on this network`);
  if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) return account.owner;
  throw new Error("This address is not owned by SPL Token or Token-2022.");
}

/** Resolves decimals from the chain (symbol from the known list, else "tokens"). */
export async function resolveToken(connection: Connection, mint: string): Promise<TokenInfo> {
  const known = knownToken(mint);
  if (known) return known;
  const mintKey = new PublicKey(mint);
  const tokenProgram = await tokenProgramForMint(connection, mintKey);
  const info = await getMint(connection, mintKey, "confirmed", tokenProgram);
  return { mint, decimals: info.decimals, symbol: "tokens" };
}
