export { loadConfig, saveConfig, defaultConfigDir, defaultConfigPath, defaultKeystorePath } from "./config.js";
export type { KakureConfig } from "./config.js";
export { writeKeystoreFile, readKeystoreFile, encryptKeypair, decryptKeypair, KeystoreDecryptError } from "./keystore.js";
export { CoordinatorClient, SequenceConflictError, type Envelope } from "./coordinatorClient.js";
export { sealTo, openFrom, x25519FromEd25519Seed } from "./crypto/seal.js";
export {
  deriveSessionKey,
  deriveSessionKeyFromGvsDecimal,
  gvsDecimalToBytes,
  sealSession,
  openSession,
  sealSessionJson,
  openSessionJson,
} from "./crypto/sessionSeal.js";
export { runDkgCeremony, type DkgCeremonyOptions, type DkgCeremonyResult } from "./dkg/ceremony.js";
export { publicShareAt, aggregatePublicShareAt } from "./dkg/publicShare.js";
export { pointToHex, pointFromHex } from "./dkg/pointHex.js";
// Proposal state machine (propose -> sign -> execute) and the transfer_multisig assembly/glue,
// added for workstream F's real e2e scenario (`e2e/scenario.test.ts`) -- previously reachable only
// via relative imports into this package's `src/`, now on the public barrel like the DKG ceremony
// pieces above.
export {
  createProposal,
  fetchProposal,
  signProposal,
  aggregateProposal,
  type ProposalKind,
  type ProposalPayload,
  type SignProposalOptions,
  type AggregateProposalOptions,
} from "./proposal/proposal.js";
export {
  executeProposal,
  type ProverLike,
  type ExecuteProposalOptions,
  type ExecuteProposalResult,
} from "./proposal/execute.js";
export {
  assembleTransferMultisig,
  type AssembleTransferMultisigRequest,
  type AssembledTransferMultisig,
} from "./proposal/assembleTransferMultisig.js";
export {
  serializeAssembledTransferMultisig,
  createTransferMultisigProposal,
  buildTransferMultisigInputsFromProposal,
  type TransferMultisigProposalDetails,
} from "./proposal/transferMultisigProposal.js";
