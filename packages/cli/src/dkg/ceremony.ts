/**
 * Drives a full DKG ceremony over the coordinator (I-7). Round 1 ("dkg1") is an UNENCRYPTED
 * identity announce -- there is no shared secret yet to encrypt with, so each member posts their
 * ed25519 identity + X25519 ceremony key in the clear (base64 plaintext in the envelope's
 * `ciphertext` field; the coordinator only ever sees bytes either way). Round 2 ("dkg2") is each
 * dealer's Feldman contribution (via `@kakure/sdk/tss`'s real `dealerContribute`/
 * `verifyContribution`/`aggregate`), with a per-recipient XChaCha20-Poly1305 box
 * (`crypto/seal.ts`, ECDH over each member's X25519 ceremony key) for every participant, including
 * a self-box -- carrying both this dealer's Feldman share AND a random 32-byte view-key
 * contribution `r_i` (see `DkgCeremonyResult.viewContributions`).
 *
 * `commands/group.ts` combines every member's `r_i` into the canonical group view secret via
 * `@kakure/sdk`'s `combineGroupViewContributions`/`deriveGroupViewKeyFromSecret` once this
 * resolves.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Point } from "@kakure/sdk/tss";
import { aggregate, dealerContribute, verifyContribution, type DealerContribution } from "@kakure/sdk/tss";
import type { CoordinatorClient, Envelope } from "../coordinatorClient.js";
import { openFrom, sealTo, x25519FromEd25519Seed } from "../crypto/seal.js";

export interface DkgIdentity {
  edPubHex: string; // 32-byte ed25519 public key, hex
  x25519PubHex: string;
}

/**
 * slice-2 F-3: round 1 previously carried no signature, and receivers deduped announces by
 * overwriting (`new Map(announces.map(a => [a.edPubHex, a]))`), so a later announce for the same
 * `edPubHex` silently replaced the earlier one -- anyone holding the (bearer, unauthenticated)
 * session id could re-announce a victim's identity with an attacker-controlled X25519 key and every
 * dealer would seal that victim's round-2 share to the attacker instead. `sig` is an ed25519
 * signature (by the identity being announced) over `announceSignBytes`, so an attacker without the
 * victim's ed25519 seed cannot forge a replacement announce for the victim's `edPubHex`.
 */
interface Announce extends DkgIdentity {
  kind: "announce";
  sig: string; // ed25519 signature, hex
}

/**
 * slice-2 F-2: the OUTER envelope carries only routing metadata (which dealer, which X25519 key to
 * open boxes with) -- `commitments`/`pop` (from which `gpk = Σ commitments[0]` is directly
 * computable) used to be plaintext here, which is exactly the group public key the spec says the
 * coordinator must never learn. They now live INSIDE each per-recipient sealed box
 * (`InnerDealerPayload`) instead, duplicated per recipient but never exposed to the relay.
 */
interface DealerMessage {
  kind: "dealer";
  dealerId: string; // decimal bigint
  senderX25519PubHex: string;
  /** recipientId(decimal) -> base64(sealTo(..., InnerDealerPayload)) */
  boxes: Record<string, string>;
}

/** Opened from a `DealerMessage` box: this dealer's full Feldman contribution, visible only to
 *  the recipient it was sealed for. */
interface InnerDealerPayload {
  commitments: { x: string; y: string }[];
  pop: { r: { x: string; y: string }; z: string };
  share: string;
  /** This dealer's random 32-byte view-key contribution (see `DkgCeremonyResult.viewContributions`). */
  r: string;
  /** ed25519 signature (hex), by the dealer's own announced identity, over `dealerSignBytes`
   *  (`sessionId`, `dealerId`, `commitments`, `pop`) -- authenticates the dealer's identity for
   *  THIS contribution even though the coordinator never sees `commitments`/`pop` in the clear. */
  sig: string;
}

const ANNOUNCE_DOMAIN = "kakure.dkg1.v1";
const DEALER_DOMAIN = "kakure.dkg2.v1";

/** Signed bytes for a round-1 announce: binds the session and the announced X25519 key. */
function announceSignBytes(sessionId: string, x25519Pub: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${ANNOUNCE_DOMAIN}|${sessionId}|`);
  const out = new Uint8Array(header.length + x25519Pub.length);
  out.set(header, 0);
  out.set(x25519Pub, header.length);
  return out;
}

/**
 * Signed bytes for a round-2 dealer contribution: binds the session, the dealer's claimed id, its
 * Feldman commitments and proof-of-possession -- signed ONCE by the dealer and embedded (identically)
 * inside every recipient's sealed box, so each recipient can authenticate the dealer's identity for
 * this exact (commitments, pop) pair without the coordinator ever seeing either in the clear.
 */
function dealerSignBytes(
  sessionId: string,
  dealerId: string,
  commitments: { x: string; y: string }[],
  pop: { r: { x: string; y: string }; z: string },
): Uint8Array {
  const canonical = JSON.stringify({ sessionId, dealerId, commitments, pop });
  return new TextEncoder().encode(`${DEALER_DOMAIN}|${canonical}`);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}
function pointToHex(p: Point): { x: string; y: string } {
  return { x: p[0].toString(16), y: p[1].toString(16) };
}
function pointFromHex(h: { x: string; y: string }): Point {
  return [BigInt("0x" + h.x), BigInt("0x" + h.y)];
}

export interface DkgCeremonyResult {
  sessionId: string;
  myId: bigint;
  threshold: number;
  memberCount: number;
  participantIds: bigint[];
  gpk: Point;
  mySecretShare: bigint;
  /** Every qualified dealer's public Feldman commitments, keyed by dealer id -- PUBLIC data (no
   *  share values), sufficient for anyone to compute any participant's public share (used to
   *  verify FROST signature shares when signing). */
  dealerCommitments: Map<bigint, Point[]>;
  /**
   * Every qualified dealer's random 32-byte view-key contribution `r_i`, keyed by dealer id. Feed
   * into `@kakure/sdk`'s `combineGroupViewContributions(contribs, gpk)` (as
   * `{index: Number(dealerId), r}[]`) to get the group's canonical view secret `gvs`, then
   * `deriveGroupViewKeyFromSecret(gvs, gpk)` for the canonical `(v, V)` -- see `commands/group.ts`.
   */
  viewContributions: Map<bigint, Uint8Array>;
}

export interface DkgCeremonyOptions {
  coordinator: CoordinatorClient;
  sessionId: string;
  threshold: number;
  memberCount: number;
  /** This member's Solana keypair 32-byte secret SEED -- used only locally to derive the X25519
   *  ceremony key; NEVER transmitted (see `ed25519PublicKey` for the identity that IS announced). */
  ed25519Seed: Uint8Array;
  /** This member's 32-byte ed25519 PUBLIC key -- the identity broadcast in the round-1 announce. */
  ed25519PublicKey: Uint8Array;
  /** Ceremony domain separator, e.g. derived from `sessionId`; must be identical across members. */
  context: bigint;
  /** Poll cadence knob for tests; production default lives in `CoordinatorClient`. */
  maxRounds?: number;
}

/** Runs both rounds of the ceremony end to end and returns this member's share of `gpk`. */
export async function runDkgCeremony(opts: DkgCeremonyOptions): Promise<DkgCeremonyResult> {
  const { coordinator, sessionId, threshold, memberCount, ed25519Seed, ed25519PublicKey, context } = opts;
  const my = x25519FromEd25519Seed(ed25519Seed);

  // Round 1: announce. The PUBLIC key is the identity; the seed itself is never transmitted.
  // Signed (slice-2 F-3) so a later announce for the same identity can be authenticated (and a
  // forged/conflicting one rejected) rather than silently trusted by dedupe-by-overwrite.
  const announce: Announce = {
    kind: "announce",
    edPubHex: hex(ed25519PublicKey),
    x25519PubHex: hex(my.pub),
    sig: hex(ed25519.sign(announceSignBytes(sessionId, my.pub), ed25519Seed)),
  };
  await coordinator.appendNext(sessionId, "dkg1", b64(new TextEncoder().encode(JSON.stringify(announce))));

  const dkg1 = await coordinator.collectUntil(
    sessionId,
    (all) => all.filter((e) => e.kind === "dkg1").length >= memberCount,
    { maxRounds: opts.maxRounds },
  );
  const announces = dkg1
    .filter((e) => e.kind === "dkg1")
    .map((e) => JSON.parse(new TextDecoder().decode(fromB64(e.ciphertext))) as Announce);

  // slice-2 F-3: verify every announce's signature against its OWN claimed `edPubHex` before
  // trusting it at all -- an unsigned/mis-signed announce cannot come from that identity's holder.
  for (const a of announces) {
    let ok: boolean;
    try {
      ok = ed25519.verify(fromHex(a.sig), announceSignBytes(sessionId, fromHex(a.x25519PubHex)), fromHex(a.edPubHex));
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`dkg: bad announce signature from ${a.edPubHex} (aborting ceremony)`);
  }
  // slice-2 F-3: NEVER dedupe by overwrite (`new Map(...)` silently kept only the LAST announce
  // per `edPubHex`, letting a later, attacker-forged... well, now signature-verified-but-still-
  // POSSIBLY-CONFLICTING announce win). Group by identity and reject outright if any identity has
  // two verified announces disagreeing on the X25519 key -- that can only happen if the identity's
  // own seed signed two different keys (a bug) or if verification above was somehow bypassed; either
  // way, silently picking one would be unsafe, so abort instead.
  const byEdPub = new Map<string, Announce>();
  for (const a of announces) {
    const prior = byEdPub.get(a.edPubHex);
    if (prior !== undefined && prior.x25519PubHex !== a.x25519PubHex) {
      throw new Error(`dkg: conflicting announce for identity ${a.edPubHex} (aborting ceremony)`);
    }
    byEdPub.set(a.edPubHex, a);
  }
  const sorted = [...byEdPub.values()].sort((a, b) => (a.edPubHex < b.edPubHex ? -1 : a.edPubHex > b.edPubHex ? 1 : 0));
  if (sorted.length !== memberCount) {
    throw new Error(`dkg: expected ${memberCount} distinct announces, saw ${sorted.length}`);
  }
  const participantIds = sorted.map((_, i) => BigInt(i + 1));
  const idByEdPub = new Map(sorted.map((a, i) => [a.edPubHex, BigInt(i + 1)]));
  const x25519PubByEdPub = new Map(sorted.map((a) => [a.edPubHex, fromHex(a.x25519PubHex)]));
  const edPubById = new Map(sorted.map((a, i) => [BigInt(i + 1), a.edPubHex]));
  const myEdPubHex = hex(ed25519PublicKey);
  const myId = idByEdPub.get(myEdPubHex);
  if (myId === undefined) throw new Error("dkg: my own announce was not observed back from the coordinator");

  // Round 2: every member is also a dealer. `rHex` is this dealer's random 32-byte contribution to
  // the group's canonical view key (see `DkgCeremonyResult.viewContributions`'s doc comment). It
  // is the SAME value in every recipient's box (a broadcast, sealed like the share is only so the
  // coordinator never sees it, not secret-shared the way the FROST share is).
  const { contribution } = await dealerContribute(myId, participantIds, threshold, context);
  const rBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const rHex = hex(rBytes);
  const dealerCommitmentsHex = contribution.commitments.map(pointToHex);
  const dealerPop = { r: pointToHex(contribution.pop.R), z: contribution.pop.z.toString() };
  // Signed ONCE; every recipient's box carries the SAME signature over the SAME (commitments, pop)
  // -- slice-2 F-2: commitments/pop (hence `gpk = Σ commitments[0]`) never appear outside a box.
  const dealerSig = hex(ed25519.sign(dealerSignBytes(sessionId, myId.toString(), dealerCommitmentsHex, dealerPop), ed25519Seed));
  const boxes: Record<string, string> = {};
  for (const [edPubHex, id] of idByEdPub) {
    const recipientX25519Pub = x25519PubByEdPub.get(edPubHex);
    if (recipientX25519Pub === undefined) continue;
    const share = contribution.shares.get(id);
    if (share === undefined) continue;
    const inner: InnerDealerPayload = {
      commitments: dealerCommitmentsHex,
      pop: dealerPop,
      share: share.toString(),
      r: rHex,
      sig: dealerSig,
    };
    const sealed = sealTo(my.priv, recipientX25519Pub, sessionId, new TextEncoder().encode(JSON.stringify(inner)));
    boxes[id.toString()] = b64(sealed);
  }
  const dealerMsg: DealerMessage = {
    kind: "dealer",
    dealerId: myId.toString(),
    senderX25519PubHex: hex(my.pub),
    boxes,
  };
  await coordinator.appendNext(sessionId, "dkg2", b64(new TextEncoder().encode(JSON.stringify(dealerMsg))));

  const dkg2 = await coordinator.collectUntil(
    sessionId,
    (all) => all.filter((e) => e.kind === "dkg2").length >= memberCount,
    { maxRounds: opts.maxRounds },
  );
  const dealerMsgs = dkg2
    .filter((e) => e.kind === "dkg2")
    .map((e) => JSON.parse(new TextDecoder().decode(fromB64(e.ciphertext))) as DealerMessage);

  const contributions: DealerContribution[] = [];
  const viewContributions = new Map<bigint, Uint8Array>();
  for (const msg of dealerMsgs) {
    const dealerId = BigInt(msg.dealerId);
    const dealerEdPubHex = edPubById.get(dealerId);
    if (dealerEdPubHex === undefined) {
      throw new Error(`dkg: dealer message claims unknown dealer id ${dealerId} (aborting ceremony)`);
    }
    const box = msg.boxes[myId.toString()];
    if (box === undefined) throw new Error(`dkg: dealer ${dealerId} sent no box for me (${myId})`);
    // slice-2 F-2: commitments/pop live INSIDE the box -- only THIS recipient (who can open it)
    // ever sees them, unlike the old plaintext-outer-envelope layout.
    const opened = openFrom(my.priv, fromHex(msg.senderX25519PubHex), sessionId, fromB64(box));
    const inner = JSON.parse(new TextDecoder().decode(opened)) as InnerDealerPayload;

    // slice-2 F-3: verify the dealer message was actually signed by the identity round 1 assigned
    // that dealer id, over exactly this (commitments, pop) -- rejects a contribution relabeled to
    // a different dealer id, edited in transit, or never signed at all. Verified AFTER opening
    // (the signature is only meaningful once we know what it covers), but before any of its
    // contents are trusted for aggregation.
    let dealerSigOk: boolean;
    try {
      dealerSigOk = ed25519.verify(
        fromHex(inner.sig),
        dealerSignBytes(sessionId, msg.dealerId, inner.commitments, inner.pop),
        fromHex(dealerEdPubHex),
      );
    } catch {
      dealerSigOk = false;
    }
    if (!dealerSigOk) {
      throw new Error(`dkg: bad dealer-message signature from dealer ${dealerId} (aborting ceremony)`);
    }

    const myShare = BigInt(inner.share);
    const contribution: DealerContribution = {
      id: dealerId,
      commitments: inner.commitments.map(pointFromHex),
      pop: { R: pointFromHex(inner.pop.r), z: BigInt(inner.pop.z) },
      shares: new Map([[myId, myShare]]),
    };
    const ok = await verifyContribution(myId, contribution, context);
    if (!ok) throw new Error(`dkg: dealer ${dealerId}'s contribution failed verification (aborting ceremony)`);
    contributions.push(contribution);
    viewContributions.set(dealerId, fromHex(inner.r));
  }

  const { C, shares } = aggregate([myId], contributions);
  return {
    sessionId,
    myId,
    threshold,
    memberCount,
    participantIds,
    gpk: C,
    mySecretShare: shares.get(myId)!,
    dealerCommitments: new Map(contributions.map((c) => [c.id, c.commitments])),
    viewContributions,
  };
}

export type { DealerMessage, Announce };
export { Envelope };
