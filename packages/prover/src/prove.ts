import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle, type ProverPort } from "@kakure/sdk/tx";
import { artifactPaths, hasArtifacts } from "./artifacts.js";
import { circuitNameFor } from "./circuitNames.js";
import { ArtifactsMissingError, ProofError } from "./errors.js";
import { proveWithSunspot, readBinaryFile, verifyWithSunspot } from "./sunspot.js";
import { decodePublicWitness } from "./decode.js";
import { compressProof } from "./compress.js";
import { executeWitness, loadCompiledCircuit, writeWitnessFile } from "./witness.js";

export interface ProveOptions {
  /** Overrides `KAKURE_ARTIFACTS_DIR` / the `circuits/target` default for this call only. */
  artifactsDir?: string;
  /** Overrides `SUNSPOT_BIN` / `/usr/local/bin/sunspot` for this call only. */
  sunspotBin?: string;
  /** Skip the self-verify step (default false). Only ever useful for benchmarking. */
  skipSelfVerify?: boolean;
}

/**
 * I-6: `prove(circuitId, inputs) -> ProofBundle`. `inputs` is the exact Noir `InputMap` for the
 * circuit (built by `@kakure/prover/circuits`'s per-circuit builders, or handed in already built).
 * Pipeline: `noir_js` executes the circuit to a gzip witness -> `sunspot prove` -> parse `.proof`
 * / `.pw` -> self-verify with `sunspot verify` -> return `{ circuitId, proof, publicInputs }`.
 *
 * ALWAYS LOCAL: nothing here ever leaves this process; the witness (which contains the caller's
 * spend scalar) is written to a private temp directory and removed after proving.
 *
 * NOTE on `.proof`/`.pw` placement: `sunspot prove` derives its output paths from the `.ccs`
 * file's path, not the witness path (see `sunspot.ts`'s doc comment) -- so this call OVERWRITES
 * `<artifactsDir>/<circuit>.proof` and `.pw` as a side effect. `artifactsDir` must therefore be
 * writable; point it at a private copy (e.g. symlinks into a temp dir) when the canonical build
 * output directory is read-only or shared.
 */
export async function prove(
  circuitId: CircuitId,
  inputs: Record<string, unknown>,
  opts: ProveOptions = {},
): Promise<ProofBundle> {
  const circuitName = circuitNameFor(circuitId);
  if (!hasArtifacts(circuitName, opts.artifactsDir)) {
    throw new ArtifactsMissingError(circuitName, artifactPaths(circuitName, opts.artifactsDir).acir);
  }
  const paths = artifactPaths(circuitName, opts.artifactsDir);
  const circuit = await loadCompiledCircuit(paths.acir);
  const witness = await executeWitness(circuitName, circuit, inputs as never);

  const workDir = await mkdtemp(join(tmpdir(), `kakure-prove-${circuitName}-`));
  try {
    const witnessPath = join(workDir, "witness.gz");
    await writeWitnessFile(witnessPath, witness);

    const { proofPath, pwPath } = await proveWithSunspot(circuitName, paths, witnessPath, opts.sunspotBin);

    if (!opts.skipSelfVerify) {
      const ok = await verifyWithSunspot(circuitName, paths.vk, proofPath, pwPath, opts.sunspotBin);
      if (!ok) {
        throw new ProofError(circuitName, "self-verify (sunspot verify) failed on a freshly generated proof");
      }
    }

    const proof = await readBinaryFile(proofPath);
    const pw = await readBinaryFile(pwPath);
    const publicInputs = decodePublicWitness(pw);

    const expected = PUBLIC_INPUT_COUNT[circuitId];
    if (publicInputs.length !== expected) {
      throw new ProofError(
        circuitName,
        `I-1 expects ${expected} public inputs for circuit ${circuitId}, sunspot produced ${publicInputs.length}`,
      );
    }

    // Workstream G: the on-chain wire format now carries a compressed 192-byte proof (see
    // programs/kakure_pool/src/instruction.rs's module docs and this package's compress.ts).
    // `ProofBundle.proof` is that compressed form from here on -- `@kakure/sdk`'s `TxBuilder`
    // writes it straight through as a fixed [u8; 192], with no compression logic of its own (the
    // sdk cannot depend on this package -- see tx/ports.ts's file doc on the dependency
    // direction). The uncompressed bytes remain available via `proofBytesForChain`/`decodeProof`
    // for `sunspot verify` parity tests, which still want the uncompressed CPI layout; the
    // self-verify step above already ran against the uncompressed `.proof`/`.pw` files on disk.
    const compressedProof = compressProof({ proof, publicInputs });
    return { circuitId, proof: compressedProof, publicInputs };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** `ProverPort` (sdk `tx/ports.ts`) implementation over this package's local `prove`. */
export function nativeProverPort(opts: ProveOptions = {}): ProverPort {
  return {
    async capabilities() {
      const circuits = (Object.values(CircuitId).filter((v) => typeof v === "number") as CircuitId[]).filter(
        (id) => hasArtifacts(circuitNameFor(id), opts.artifactsDir),
      );
      return { circuits, environment: "native" as const };
    },
    async prove(circuit, inputs) {
      return prove(circuit, inputs, opts);
    },
  };
}
