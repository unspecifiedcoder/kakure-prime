/**
 * `@kakure/cli`'s `buildTransferMultisigInputsFromProposal` (used by `treasuryFlows.ts`) imports
 * `buildTransferMultisigInputMap` from `@kakure/prover` -- a pure, browser-safe function -- but
 * `@kakure/prover` has one entry point that ALSO pulls in its Node-only proving code (`config.ts`,
 * `sunspot.ts`, `witness.ts`), which does `import { resolve } from "path"`, `spawn` from
 * `child_process`, etc. Those are never called from the browser (this app only ever proves through
 * the Kakure Helper's HTTP API, never `nativeProverPort` directly), but Rollup still needs every
 * import target to resolve to SOMETHING with the right named exports before it can tree-shake the
 * unused function bodies away. This single shim module aliases every Node builtin those files
 * import, exporting stubs that throw if anything ever actually calls them (it shouldn't).
 */
function unreachable(name: string): never {
  throw new Error(`${name}: not available in the browser (this should never run client-side)`);
}

export function resolve(..._segments: string[]): string {
  return unreachable("path.resolve");
}
export function join(..._segments: string[]): string {
  return unreachable("path.join");
}
export function dirname(_path: string): string {
  return unreachable("path.dirname");
}
export function existsSync(_path: string): boolean {
  return unreachable("fs.existsSync");
}
export async function readFile(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.readFile");
}
export async function writeFile(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.writeFile");
}
export async function mkdir(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.mkdir");
}
export async function chmod(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.chmod");
}
export async function mkdtemp(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.mkdtemp");
}
export async function rm(..._args: unknown[]): Promise<never> {
  return unreachable("fs/promises.rm");
}
export function tmpdir(): string {
  return unreachable("os.tmpdir");
}
export function homedir(): string {
  return unreachable("os.homedir");
}
export function spawn(..._args: unknown[]): never {
  return unreachable("child_process.spawn");
}
