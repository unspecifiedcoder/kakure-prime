import { Keypair } from "@solana/web3.js";
import { writeKeystoreFile } from "../keystore.js";

export interface KeygenOptions {
  keystorePath: string;
  passphrase: string;
  /** Test hook: inject a deterministic keypair instead of generating a fresh one. */
  keypair?: Keypair;
}

export interface KeygenResult {
  publicKey: string;
  keystorePath: string;
}

export async function runKeygen(opts: KeygenOptions): Promise<KeygenResult> {
  const keypair = opts.keypair ?? Keypair.generate();
  await writeKeystoreFile(opts.keystorePath, keypair, opts.passphrase);
  return { publicKey: keypair.publicKey.toBase58(), keystorePath: opts.keystorePath };
}
