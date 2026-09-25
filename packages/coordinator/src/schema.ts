import { z } from "zod";

/**
 * I-7 coordinator envelope, byte-for-byte:
 *   { session_id: string /* hex32 *\/; seq: number; kind: "dkg1"|"dkg2"|"proposal"|"nonce"|"share"|"final"; ciphertext: string /* base64 *\/ }
 */
export const EnvelopeKind = z.enum(["dkg1", "dkg2", "proposal", "nonce", "share", "final"]);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

const HEX32 = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const EnvelopeSchema = z.object({
  session_id: z.string().regex(HEX32, "session_id must be 64 hex chars (32 bytes)"),
  seq: z.number().int().nonnegative(),
  kind: EnvelopeKind,
  ciphertext: z
    .string()
    .refine((v) => v.length % 4 === 0 && BASE64.test(v), "ciphertext must be base64"),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(input: unknown): Envelope {
  return EnvelopeSchema.parse(input);
}
