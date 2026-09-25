import { existsSync } from "node:fs";

/**
 * Workstream A's circuit build output. Its worktree (`kakure-wt/a-circuits`) is READ-ONLY for
 * workstream D per the master plan; main only commits the `.json`/`.vk` (the `.ccs`/`.pk`/`.so`
 * needed for a real `sunspot prove` are gitignored and only exist in a build worktree). Override
 * with `KAKURE_TEST_ARTIFACTS_DIR` to point at a different build.
 */
export const A_ARTIFACTS_DIR =
  process.env.KAKURE_TEST_ARTIFACTS_DIR ?? "/mnt/e/github2/kakure-wt/a-circuits/circuits/target";

export function hasRealArtifacts(circuit: string): boolean {
  return (
    existsSync(`${A_ARTIFACTS_DIR}/${circuit}.json`) &&
    existsSync(`${A_ARTIFACTS_DIR}/${circuit}.ccs`) &&
    existsSync(`${A_ARTIFACTS_DIR}/${circuit}.pk`) &&
    existsSync(`${A_ARTIFACTS_DIR}/${circuit}.vk`)
  );
}

export function hasPrebuiltProof(circuit: string): boolean {
  return (
    existsSync(`${A_ARTIFACTS_DIR}/${circuit}.proof`) && existsSync(`${A_ARTIFACTS_DIR}/${circuit}.pw`)
  );
}
