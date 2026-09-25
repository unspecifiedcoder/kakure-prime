import { resolve } from "node:path";

/**
 * Where the Sunspot build output (`<circuit>.{json,ccs,pk,vk}`, workstream A) lives. Defaults to
 * `circuits/target` relative to the process cwd (the monorepo root when run via `pnpm`/`just`),
 * overridable per-call (`opts.artifactsDir`) or via `KAKURE_ARTIFACTS_DIR` so CI and CLI users can
 * point at a build produced elsewhere without editing code.
 */
export function resolveArtifactsDir(explicit?: string): string {
  const dir = explicit ?? process.env.KAKURE_ARTIFACTS_DIR ?? "circuits/target";
  return resolve(dir);
}

/** Absolute path to the `sunspot` binary; overridable for environments where it is not on PATH. */
export function resolveSunspotBin(explicit?: string): string {
  return explicit ?? process.env.SUNSPOT_BIN ?? "/usr/local/bin/sunspot";
}
