export { resolveArtifactsDir, resolveSunspotBin } from "./config.js";
export { ProofInputError, ProofError, ArtifactsMissingError } from "./errors.js";
export { pointHex, marshalU128, marshalNote, memoRecipientPoints, type NoteInput } from "./marshal.js";
export { artifactPaths, hasArtifacts, type CircuitArtifactPaths } from "./artifacts.js";
export { executeWitness, loadCompiledCircuit, writeWitnessFile } from "./witness.js";
export { proveWithSunspot, verifyWithSunspot, readBinaryFile } from "./sunspot.js";
export {
  decodePublicWitness,
  decodeProof,
  encodePublicWitness,
  proofBytesForChain,
  type DecodedProof,
} from "./decode.js";
export { CIRCUIT_NAMES, circuitNameFor } from "./circuitNames.js";
export { compressProof, compressDecodedProof, compressG1, compressG2, COMPRESSED_PROOF_LEN } from "./compress.js";
export { prove, nativeProverPort, type ProveOptions } from "./prove.js";
export * from "./circuits/types.js";
export * from "./circuits/builders.js";
