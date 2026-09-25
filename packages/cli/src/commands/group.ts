import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { Poseidon, Fr } from "@kakure/sdk";
import { deriveGroupViewKeyFromSecret } from "@kakure/sdk/frost";
import { combineGroupViewContributions, type Point } from "@kakure/sdk/tss";
import { CoordinatorClient } from "../coordinatorClient.js";
import { runDkgCeremony } from "../dkg/ceremony.js";
import { pointToHex } from "../dkg/pointHex.js";
import { writeEncryptedJsonFile } from "../keystore.js";

export interface GroupRecord {
  sessionId: string;
  threshold: number;
  memberCount: number;
  myId: string;
  participantIds: string[];
  gpk: { x: string; y: string };
  mySecretShare: string;
  /** The group's CANONICAL view key, identical for every member: derived from `gvs`
   *  (`@kakure/sdk/tss`'s `combineGroupViewContributions` over every dealer's round-2 `r_i`), via
   *  `@kakure/sdk/frost`'s `deriveGroupViewKeyFromSecret`. Unlike the deprecated per-account
   *  `deriveGroupViewKey`, every member computes the identical `(v, V)` here. */
  groupViewKey: { gvs: string; v: string; V: { x: string; y: string }; roll: string };
  /** dealer id (decimal) -> that dealer's Feldman commitments (hex points), PUBLIC data needed to
   *  compute any signer's public share for FROST signature-share verification (see proposal.ts). */
  dealerCommitments: Record<string, { x: string; y: string }[]>;
}

export interface GroupCeremonyOptions {
  coordinatorUrl: string;
  sessionId?: string; // omitted -> generate a fresh hex32 session id (i.e. "group create")
  threshold: number;
  memberCount: number;
  keypair: Keypair;
  groupStorePath: string;
  passphrase: string;
  maxRounds?: number;
}

async function sessionContext(sessionId: string): Promise<bigint> {
  const bytes = Buffer.from(sessionId, "hex");
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return (await Poseidon.hash([new Fr(acc % (1n << 251n))])).toBigInt();
}

/** Shared by `group create` (generates a fresh session id) and `group join` (uses a given one). */
export async function runGroupCeremony(opts: GroupCeremonyOptions): Promise<GroupRecord> {
  const sessionId = opts.sessionId ?? Buffer.from(randomBytes(32)).toString("hex");
  const coordinator = new CoordinatorClient(opts.coordinatorUrl);
  const context = await sessionContext(sessionId);

  const result = await runDkgCeremony({
    coordinator,
    sessionId,
    threshold: opts.threshold,
    memberCount: opts.memberCount,
    ed25519Seed: opts.keypair.secretKey.slice(0, 32),
    ed25519PublicKey: opts.keypair.publicKey.toBytes(),
    context,
    maxRounds: opts.maxRounds,
  });

  // Canonical group view key: combine every qualified dealer's round-2 `r_i` (order-independent)
  // into the group's shared view secret `gvs`, then derive `(v, V)` from it. Every member who ran
  // the same ceremony -- and therefore holds the same `viewContributions` -- computes the IDENTICAL
  // `(v, V)`, unlike the deprecated per-account `deriveGroupViewKey`.
  const gpk: Point = result.gpk;
  const contribs = [...result.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
  const gvs = await combineGroupViewContributions(contribs, gpk);
  const groupView = await deriveGroupViewKeyFromSecret(gvs, gpk as [bigint, bigint]);

  const record: GroupRecord = {
    sessionId,
    threshold: opts.threshold,
    memberCount: opts.memberCount,
    myId: result.myId.toString(),
    participantIds: result.participantIds.map((id) => id.toString()),
    gpk: pointToHex(result.gpk),
    mySecretShare: result.mySecretShare.toString(),
    groupViewKey: {
      gvs: gvs.toString(),
      v: groupView.v.toString(),
      V: { x: groupView.V[0].toString(16), y: groupView.V[1].toString(16) },
      roll: groupView.roll.toString(),
    },
    dealerCommitments: Object.fromEntries(
      [...result.dealerCommitments].map(([id, commitments]) => [id.toString(), commitments.map(pointToHex)]),
    ),
  };
  await writeEncryptedJsonFile(opts.groupStorePath, record, opts.passphrase);
  return record;
}
