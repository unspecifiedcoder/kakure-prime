import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveArtifactsDir } from "./config.js";

export interface CircuitArtifactPaths {
  readonly acir: string;
  readonly ccs: string;
  readonly pk: string;
  readonly vk: string;
}

export function artifactPaths(circuitName: string, artifactsDir?: string): CircuitArtifactPaths {
  const dir = resolveArtifactsDir(artifactsDir);
  return {
    acir: join(dir, `${circuitName}.json`),
    ccs: join(dir, `${circuitName}.ccs`),
    pk: join(dir, `${circuitName}.pk`),
    vk: join(dir, `${circuitName}.vk`),
  };
}

/** True iff every artifact file Sunspot's `prove`/`verify` pipeline needs exists on disk. */
export function hasArtifacts(circuitName: string, artifactsDir?: string): boolean {
  const paths = artifactPaths(circuitName, artifactsDir);
  return existsSync(paths.acir) && existsSync(paths.ccs) && existsSync(paths.pk) && existsSync(paths.vk);
}
