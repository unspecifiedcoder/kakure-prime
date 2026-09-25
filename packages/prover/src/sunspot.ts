import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolveSunspotBin } from "./config.js";
import { ProofError } from "./errors.js";
import type { CircuitArtifactPaths } from "./artifacts.js";

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * `sunspot prove <acir> <witness.gz> <ccs> <pk>` derives its output paths from the CCS path, NOT
 * the witness path (`go/cmd/prove.go`: `base := ccsPath[:len(ccsPath)-len(ext(ccsPath))]`, then
 * writes `<base>.proof` and `<base>.pw`) -- so proving with a `<dir>/<circuit>.ccs` always
 * produces `<dir>/<circuit>.proof` and `<dir>/<circuit>.pw`, overwriting any prior run's output
 * for that circuit in that directory. Every argument's extension is validated strictly by Sunspot
 * (`.json`/`.gz`/`.ccs`/`.pk`).
 */
export async function proveWithSunspot(
  circuitName: string,
  paths: Pick<CircuitArtifactPaths, "acir" | "ccs" | "pk">,
  witnessPath: string,
  sunspotBin?: string,
): Promise<{ proofPath: string; pwPath: string }> {
  if (!witnessPath.endsWith(".gz")) {
    throw new ProofError(circuitName, `witness path must end with .gz, got ${witnessPath}`);
  }
  const bin = resolveSunspotBin(sunspotBin);
  const { code, stdout, stderr } = await run(bin, [
    "prove",
    paths.acir,
    witnessPath,
    paths.ccs,
    paths.pk,
  ]);
  if (code !== 0) {
    throw new ProofError(circuitName, `sunspot prove exited ${code}: ${stderr || stdout}`);
  }
  const base = paths.ccs.replace(/\.ccs$/, "");
  return { proofPath: `${base}.proof`, pwPath: `${base}.pw` };
}

export async function verifyWithSunspot(
  circuitName: string,
  vkPath: string,
  proofPath: string,
  pwPath: string,
  sunspotBin?: string,
): Promise<boolean> {
  const bin = resolveSunspotBin(sunspotBin);
  const { code, stdout, stderr } = await run(bin, ["verify", vkPath, proofPath, pwPath]);
  if (code !== 0) {
    throw new ProofError(circuitName, `sunspot verify exited ${code}: ${stderr || stdout}`);
  }
  return /verification successful/i.test(stdout) || code === 0;
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}
