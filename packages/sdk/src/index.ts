export type { DerivedEph } from "./types/ephemeral.js";
export * from "./interfaces.js";
export * from "./crypto/fields.js";
export * from "./crypto/index.js";
export * from "./keys/SolanaAccount.js";
export * from "./address.js";
export * from "./merkle/LeanIMT.js";
export * from "./note/note.js";
export * from "./note/nullifier.js";
export * from "./note/keys.js";
export * from "./note/complianceKeys.js";
export { mintIncomingNote } from "./note/mint.js";
export type { MintedNote } from "./note/mint.js";
export * from "./merkle/genesis.js";
export * from "./discovery/types.js";
export * from "./discovery/codec.js";
export * from "./discovery/reconstruct.js";
export {
  MAX_PREFLIGHT_CANDIDATES,
  PREFLIGHT_COLLISION_BATCH_SIZE,
  SelfMintAuthorizationError,
  SelfMintPreflight,
  SelfMintPreflightError,
  opensExistingSelfRecord,
} from "./discovery/preflight.js";
export type {
  AuthorizedSelfMintCandidate,
  SelfMintAllocator,
  SelfMintAuthorization,
  SelfMintAuthorizationFailure,
  SelfMintCandidate,
  SelfMintContext,
  SelfMintPreflightFailure,
} from "./discovery/preflight.js";
export * from "./discovery/reconcile.js";
export * from "./state/EphemeralCounterStore.js";
export * from "./state/PersistentEphemeralCounterStore.js";
export type { ProverNoteInput } from "./note/mint.js";
// `IKeyRepository`/`IUtxoRepository` (the interfaces `ScanEngine` and `MultisigScanEngine` are typed
// against) and their concrete implementations, plus `WalletNote` (what a scan yields and what
// `IUtxoRepository` stores). Previously only reachable via `src/reference.ts`; every consumer that builds a
// working `ScanEngine` (e.g. `@kakure/cli`) needs these from the main barrel.
export * from "./repositories.js";
export type { WalletNote } from "./state/types.js";
export * from "./state/KeyRepository.js";
export * from "./state/UtxoRepository.js";
export {
  ScanEngine,
  MultisigScanEngine,
  httpNotesTransport,
  type IndexerNoteInserted,
  type NotesTransport,
} from "./sync/ScanEngine.js";
