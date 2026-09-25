import type { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";

// Spec §3.3 / master plan global constraints: recipient_field =
// sha256("kakure.recipient.v1" || destination_token_account) with byte 0 zeroed, so the result is always
// < the BN254 scalar field modulus (top byte < 0x30, so zeroing it is sufficient and cheap on-chain).
const RECIPIENT_DOMAIN = new TextEncoder().encode("kakure.recipient.v1");

/** The pool recomputes this from the destination account passed in the `withdraw`/`withdraw_multisig`
 *  instruction and requires equality with the proof's public `recipient` input. */
export function recipientField(destinationTokenAccount: PublicKey): Uint8Array {
  const input = new Uint8Array(RECIPIENT_DOMAIN.length + 32);
  input.set(RECIPIENT_DOMAIN, 0);
  input.set(destinationTokenAccount.toBytes(), RECIPIENT_DOMAIN.length);
  const digest = sha256(input);
  digest[0] = 0x00;
  return digest;
}
