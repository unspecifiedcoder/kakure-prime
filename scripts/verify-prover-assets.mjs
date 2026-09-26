import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = resolve(root, "apps/web/public/prover-wasm");
const manifest = JSON.parse(await readFile(resolve(bundleDir, "manifest.json"), "utf8"));

if (manifest.setup !== "INSECURE-DEVELOPMENT-ONLY" || manifest.network !== "solana-devnet") {
  throw new Error("browser prover manifest must remain explicitly development-only and devnet-scoped");
}

for (const [relativePath, expected] of Object.entries(manifest.files)) {
  if (relativePath.includes("..") || relativePath.startsWith("/")) {
    throw new Error(`unsafe prover manifest path: ${relativePath}`);
  }
  const path = resolve(bundleDir, relativePath);
  const info = await stat(path);
  if (info.size !== expected.bytes) {
    throw new Error(`${relativePath}: expected ${expected.bytes} bytes, found ${info.size}`);
  }
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  if (sha256 !== expected.sha256) {
    throw new Error(`${relativePath}: SHA-256 mismatch (${sha256})`);
  }
  console.log(`verified ${relativePath} (${info.size} bytes)`);
}
