/**
 * Browser port of `packages/cli/src/commands/group.ts`'s `runGroupCeremony`. The DKG ceremony
 * (`@kakure/cli`'s `runDkgCeremony`) needs a raw ed25519 SEED to derive the X25519 ceremony key it
 * seals round-2 messages with (`x25519FromEd25519Seed`) -- but a wallet-standard adapter (Phantom)
 * only ever exposes `signMessage()`, never a seed (see `src/lib/wallet.ts`'s doc comment for the
 * exact same constraint on `SolanaAccount`). So treasury creation/joining uses a freshly generated,
 * LOCAL ed25519 keypair as the ceremony's transport identity -- distinct from the connected wallet,
 * which stays the on-chain fee payer/signer for deposit/execute transactions. This mirrors the CLI's
 * own `keygen` + `group create` split (a keystore keypair for the ceremony, separate from however
 * the operator funds transactions).
 */
import { Keypair } from "@solana/web3.js";
import { Poseidon, Fr } from "@kakure/sdk";
import { deriveGroupViewKeyFromSecret } from "@kakure/sdk/frost";
import { combineGroupViewContributions, type Point } from "@kakure/sdk/tss";
import { CoordinatorClient, runDkgCeremony, pointToHex } from "@kakure/cli";
import { saveEncrypted } from "./keystore.js";

export interface GroupRecord {
  sessionId: string;
  name: string;
  threshold: number;
  memberCount: number;
  myId: string;
  participantIds: string[];
  gpk: { x: string; y: string };
  mySecretShare: string;
  groupViewKey: { gvs: string; v: string; V: { x: string; y: string }; roll: string };
  dealerCommitments: Record<string, { x: string; y: string }[]>;
  /** This member's local ceremony keypair, base64 secret key -- needed again to join a later
   *  ceremony round for split/join/withdraw_multisig proposals under the same participant id. */
  ceremonyKeypairSecretB64: string;
}

export interface CreateOrJoinTreasuryOptions {
  coordinatorUrl: string;
  name: string;
  threshold: number;
  memberCount: number;
  /** Omit to create a fresh session (treasury); provide the invite's session id to join one. */
  sessionId?: string;
  /** Encrypts the resulting `GroupRecord` (mySecretShare included) at rest in IndexedDB. */
  passphrase: string;
  maxRounds?: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sessionContext(sessionId: string): Promise<bigint> {
  let acc = 0n;
  for (let i = 0; i < sessionId.length; i += 2) {
    acc = (acc << 8n) | BigInt(parseInt(sessionId.slice(i, i + 2), 16));
  }
  return (await Poseidon.hash([new Fr(acc % (1n << 251n))])).toBigInt();
}

/**
 * Runs (or joins) a DKG ceremony to completion and saves the resulting `GroupRecord` encrypted in
 * IndexedDB, keyed by `sessionId` (the treasury's id). Resolves once every participant has posted
 * their round-2 contribution -- i.e. this call legitimately blocks on the OTHER signers opening
 * their invite link and running this same function with the same `sessionId`.
 */
export async function createOrJoinTreasury(opts: CreateOrJoinTreasuryOptions): Promise<GroupRecord> {
  const sessionId = opts.sessionId ?? randomHex32();
  const coordinator = new CoordinatorClient(opts.coordinatorUrl);
  const context = await sessionContext(sessionId);
  const ceremonyKeypair = Keypair.generate();

  const result = await runDkgCeremony({
    coordinator,
    sessionId,
    threshold: opts.threshold,
    memberCount: opts.memberCount,
    ed25519Seed: ceremonyKeypair.secretKey.slice(0, 32),
    ed25519PublicKey: ceremonyKeypair.publicKey.toBytes(),
    context,
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
  });

  const gpk: Point = result.gpk;
  const contribs = [...result.viewContributions].map(([id, r]) => ({ index: Number(id), r }));
  const gvs = await combineGroupViewContributions(contribs, gpk);
  const groupView = await deriveGroupViewKeyFromSecret(gvs, gpk as [bigint, bigint]);

  const record: GroupRecord = {
    sessionId,
    name: opts.name,
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
    ceremonyKeypairSecretB64: bytesToBase64(ceremonyKeypair.secretKey),
  };
  await saveEncrypted(sessionId, record, opts.passphrase);
  return record;
}

/** The invite link a treasury creator sends to co-signers: just the coordinator URL, session id,
 *  and ceremony params -- no secrets (same rule as claim links, spec §4). */
export interface TreasuryInvite {
  coordinatorUrl: string;
  sessionId: string;
  name: string;
  threshold: number;
  memberCount: number;
}

export function encodeInvite(invite: TreasuryInvite): string {
  const json = JSON.stringify(invite);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeInvite(token: string): TreasuryInvite {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(escape(atob(b64)));
  return JSON.parse(json) as TreasuryInvite;
}
