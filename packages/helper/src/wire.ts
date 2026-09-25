import type { CircuitId, ProofBundle } from "@kakure/sdk/tx";

/**
 * Wire format for `POST /prove`: `ProofBundle`'s `Uint8Array` fields don't survive JSON directly,
 * so the helper and its browser client both go through base64 via these two functions. Kept in
 * their own module (no fastify/browser-only imports) so `apps/web`'s `HelperProver` client can
 * import just this file without pulling in the server.
 */

export interface ProveRequestBody {
  circuit: CircuitId;
  inputs: Record<string, unknown>;
}

export interface ProveResponseBody {
  circuitId: CircuitId;
  proof: string; // base64
  publicInputs: string[]; // base64, one per field element
}

// Manual base64 (no `Buffer`, no `btoa`/`atob`) so this module works unmodified in both this
// package's Node server AND `apps/web`'s browser bundle (the browser-side `HelperProver` client
// imports this exact file).
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 0x3f];
  }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B64_CHARS.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function encodeProofBundle(bundle: ProofBundle): ProveResponseBody {
  return {
    circuitId: bundle.circuitId,
    proof: toBase64(bundle.proof),
    publicInputs: bundle.publicInputs.map((pi) => toBase64(pi)),
  };
}

export function decodeProofBundle(body: ProveResponseBody): ProofBundle {
  return {
    circuitId: body.circuitId,
    proof: fromBase64(body.proof),
    publicInputs: body.publicInputs.map((pi) => fromBase64(pi)),
  };
}
