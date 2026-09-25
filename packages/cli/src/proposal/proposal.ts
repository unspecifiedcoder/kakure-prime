/**
 * Proposal state machine: `propose` -> `sign` (each signer, independently, any number of times up
 * to `threshold`) -> `execute` (aggregate -> prove -> build ix -> send). Driven entirely over the
 * coordinator (I-7): a proposal's own envelopes on the group's session id carry the FROST round-1
 * commitments ("nonce") and round-2 shares ("share"); "proposal" carries the spend intent itself.
 *
 * Uses `@kakure/sdk/frost`'s real BabyJubJub-Poseidon2 FROST ciphersuite (`bjjCiphersuite`) for
 * round 1 (`commit`) and round 2 (`signShare`) -- this is genuine threshold Schnorr signing, not a
 * simulation. `execute`'s prove/build/send step is dependency-injected (`ProverPort`,
 * `TxBuilder`-shaped callback) so it can run against fakes in tests without a validator, per the
 * master plan's instruction for this workstream.
 */
import {
  bindingFactors,
  bjjCiphersuite,
  coordinatorAggregate,
  commit,
  encodeMessage,
  groupCommitment,
  signShare,
  type Commitment,
  type NonceHandle,
  type Signature,
} from "@kakure/sdk/frost";
import type { CoordinatorClient, Envelope } from "../coordinatorClient.js";
import type { Point } from "@kakure/sdk/tss";
import { openSessionJson, sealSessionJson } from "../crypto/sessionSeal.js";

export type ProposalKind = "transfer" | "split" | "join" | "withdraw";

export interface ProposalPayload {
  kind: ProposalKind;
  proposalId: string;
  /** The exact bytes signed -- the circuit's own `msg_transfer`/`msg_split`/... commitment,
   *  already computed by the proposer (e.g. via `@kakure/sdk/frost`'s message helpers). */
  messageHex: string;
  /** Free-form, application-defined description of the spend (asset, amount, recipient, ...);
   *  opaque to the state machine, present only for signers to review before countersigning. */
  details: Record<string, unknown>;
}

function hexToPoint(h: { x: string; y: string }): Point {
  return [BigInt("0x" + h.x), BigInt("0x" + h.y)];
}
function pointToHexObj(p: Point): { x: string; y: string } {
  return { x: p[0].toString(16), y: p[1].toString(16) };
}

/**
 * slice-2 F-2: `sessionKey` (derive with `crypto/sessionSeal.ts`'s `deriveSessionKey(gvs,
 * sessionId)`, `gvs` from `GroupRecord.groupViewKey.gvs`) seals every proposal/nonce/share
 * envelope's `ciphertext` under XChaCha20-Poly1305 -- the coordinator (or anyone else who only has
 * the session id, see F-3) now sees opaque bytes, not the spend's kind/message/details/asset/
 * amount/recipient, nor the FROST commitments or signature shares.
 */
export async function createProposal(
  coordinator: CoordinatorClient,
  sessionId: string,
  sessionKey: Uint8Array,
  payload: ProposalPayload,
): Promise<void> {
  await coordinator.appendNext(sessionId, "proposal", sealSessionJson(sessionKey, payload));
}

export async function fetchProposal(
  coordinator: CoordinatorClient,
  sessionId: string,
  sessionKey: Uint8Array,
  proposalId: string,
): Promise<ProposalPayload> {
  const matches = (e: Envelope): boolean => {
    if (e.kind !== "proposal") return false;
    try {
      return openSessionJson<ProposalPayload>(sessionKey, e.ciphertext).proposalId === proposalId;
    } catch {
      return false;
    }
  };
  const all = await coordinator.collectUntil(sessionId, (envs) => envs.some(matches), { maxRounds: 1 });
  const match = all.find(matches);
  if (!match) throw new Error(`proposal ${proposalId} not found on session ${sessionId}`);
  return openSessionJson<ProposalPayload>(sessionKey, match.ciphertext);
}

interface NonceEnvelopePayload {
  proposalId: string;
  id: string; // signer id, decimal
  D: { x: string; y: string };
  E: { x: string; y: string };
}
interface ShareEnvelopePayload {
  proposalId: string;
  id: string;
  z: string;
}

export interface SignProposalOptions {
  coordinator: CoordinatorClient;
  sessionId: string;
  /** slice-2 F-2: seals this signer's "nonce"/"share" envelopes (and is used to open the
   *  "proposal" envelope via `fetchProposal`). Derive with `deriveSessionKey(gvs, sessionId)`. */
  sessionKey: Uint8Array;
  proposalId: string;
  myId: bigint;
  mySecretShare: bigint;
  gpk: Point;
  threshold: number;
  maxRounds?: number;
}

/**
 * One signer's full round 1+2 contribution: publish this signer's nonce commitment, wait for
 * `threshold` signers' commitments to appear, then publish this signer's signature share over
 * that exact commitment set. Idempotent per signer (a re-run posts a fresh nonce -- FROST nonces
 * are one-time by construction, `NonceHandle` enforces it locally).
 */
export async function signProposal(opts: SignProposalOptions): Promise<void> {
  const { coordinator, sessionId, sessionKey, proposalId, myId, mySecretShare, gpk, threshold } = opts;
  const proposal = await fetchProposal(coordinator, sessionId, sessionKey, proposalId);
  const message = encodeMessage(BigInt(proposal.messageHex));

  const hidingRandom = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const bindingRandom = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const { nonces, commitment } = await commit(bjjCiphersuite, myId, mySecretShare, hidingRandom, bindingRandom);

  const noncePayload: NonceEnvelopePayload = {
    proposalId,
    id: myId.toString(),
    D: pointToHexObj(commitment.D as Point),
    E: pointToHexObj(commitment.E as Point),
  };
  await coordinator.appendNext(sessionId, "nonce", sealSessionJson(sessionKey, noncePayload));

  const nonceEnvelopes = await coordinator.collectUntil(
    sessionId,
    (envs) => countMatchingProposal(envs, sessionKey, "nonce", proposalId) >= threshold,
    { maxRounds: opts.maxRounds },
  );
  const commitments = decodeUnique<NonceEnvelopePayload>(nonceEnvelopes, sessionKey, "nonce", proposalId).map(
    (p: NonceEnvelopePayload): Commitment<Point> => ({
      id: BigInt(p.id),
      D: hexToPoint(p.D),
      E: hexToPoint(p.E),
    }),
  );

  const zShare = await signShare(bjjCiphersuite, myId, nonces as NonceHandle, mySecretShare, gpk, message, commitments);
  const sharePayload: ShareEnvelopePayload = { proposalId, id: myId.toString(), z: zShare.toString() };
  await coordinator.appendNext(sessionId, "share", sealSessionJson(sessionKey, sharePayload));
}

function decodeEnvelope<T>(sessionKey: Uint8Array, e: Envelope): T {
  return openSessionJson<T>(sessionKey, e.ciphertext);
}

function countMatchingProposal(
  envs: readonly Envelope[],
  sessionKey: Uint8Array,
  kind: Envelope["kind"],
  proposalId: string,
): number {
  return decodeUnique(envs, sessionKey, kind, proposalId).length;
}

function decodeUnique<T extends { proposalId: string; id: string }>(
  envs: readonly Envelope[],
  sessionKey: Uint8Array,
  kind: Envelope["kind"],
  proposalId: string,
): T[] {
  const byId = new Map<string, T>();
  for (const e of envs) {
    if (e.kind !== kind) continue;
    let parsed: T;
    try {
      parsed = decodeEnvelope<T>(sessionKey, e);
    } catch {
      continue;
    }
    if (parsed.proposalId !== proposalId) continue;
    byId.set(parsed.id, parsed);
  }
  return [...byId.values()];
}

export interface AggregateProposalOptions {
  coordinator: CoordinatorClient;
  sessionId: string;
  /** slice-2 F-2: opens the "proposal"/"nonce"/"share" envelopes. Derive with
   *  `deriveSessionKey(gvs, sessionId)`. */
  sessionKey: Uint8Array;
  proposalId: string;
  gpk: Point;
  threshold: number;
  publicShares: ReadonlyMap<string, Point>; // signer id (decimal) -> V_i
  maxRounds?: number;
}

/**
 * `execute`'s aggregation half: collects >= threshold nonce commitments and signature shares for
 * `proposalId` and aggregates them into a single FROST signature over the proposal's message,
 * verifying every share (`coordinatorAggregate` -- identifiable abort on a bad share).
 */
export async function aggregateProposal(
  opts: AggregateProposalOptions,
): Promise<{ signature: Signature<Point>; message: Uint8Array; proposal: ProposalPayload }> {
  const { coordinator, sessionId, sessionKey, proposalId, gpk, threshold, publicShares } = opts;
  const proposal = await fetchProposal(coordinator, sessionId, sessionKey, proposalId);
  const message = encodeMessage(BigInt(proposal.messageHex));

  const nonceEnvelopes = await coordinator.collectUntil(
    sessionId,
    (envs) => countMatchingProposal(envs, sessionKey, "nonce", proposalId) >= threshold,
    { maxRounds: opts.maxRounds },
  );
  const commitments = decodeUnique<NonceEnvelopePayload>(nonceEnvelopes, sessionKey, "nonce", proposalId).map(
    (p: NonceEnvelopePayload): Commitment<Point> => ({ id: BigInt(p.id), D: hexToPoint(p.D), E: hexToPoint(p.E) }),
  );

  const shareEnvelopes = await coordinator.collectUntil(
    sessionId,
    (envs) => countMatchingProposal(envs, sessionKey, "share", proposalId) >= threshold,
    { maxRounds: opts.maxRounds },
  );
  const shares = decodeUnique<ShareEnvelopePayload>(shareEnvelopes, sessionKey, "share", proposalId).map((p: ShareEnvelopePayload) => {
    const publicShare = publicShares.get(p.id);
    if (publicShare === undefined) throw new Error(`aggregateProposal: no known public share for signer ${p.id}`);
    return { id: BigInt(p.id), z: BigInt(p.z), publicShare };
  });

  // `coordinatorAggregate`/`aggregate` take R as given (they do not recompute it -- see
  // `frost.ts`'s `aggregate`), so it must be the real group commitment R = sum(D_i + rho_i * E_i)
  // per RFC 9591 4.5, using the SAME binding factors every `signShare`/`verifySignatureShare` call
  // derives from `(gpk, msg, commitments)`.
  const rhos = await bindingFactors(bjjCiphersuite, gpk, message, commitments);
  const R = groupCommitment(bjjCiphersuite, commitments, rhos) as Point;

  const signature = await coordinatorAggregate(bjjCiphersuite, R, gpk, message, commitments, shares, threshold);
  return { signature, message, proposal };
}
