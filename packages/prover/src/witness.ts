import { readFile, writeFile } from "node:fs/promises";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { ProofError } from "./errors.js";

/**
 * Executes a compiled Noir circuit against an `InputMap` to produce the witness. `Noir.execute`
 * already returns the gzip-compressed serialized witness stack (see
 * `@noir-lang/noir_js`'s `program.mjs`: `compressWitnessStack(witness_stack)`), i.e. exactly the
 * bytes Sunspot's `prove` subcommand expects in a `witness.gz` file -- no further compression
 * needed here.
 */
export async function executeWitness(
  circuitName: string,
  circuit: CompiledCircuit,
  inputs: InputMap,
): Promise<Uint8Array> {
  try {
    const noir = new Noir(circuit);
    const { witness } = await noir.execute(inputs);
    return witness;
  } catch (err) {
    throw new ProofError(circuitName, err instanceof Error ? err.message : String(err), err);
  }
}

export async function loadCompiledCircuit(acirPath: string): Promise<CompiledCircuit> {
  const raw = await readFile(acirPath, "utf-8");
  return JSON.parse(raw) as CompiledCircuit;
}

export async function writeWitnessFile(path: string, witness: Uint8Array): Promise<void> {
  await writeFile(path, witness);
}
