import type { IdlType, KakurePoolIdl } from "./idl.js";

/**
 * Decoder for `kakure_pool`'s events (frozen interface I-4).
 *
 * `kakure_pool` is a native `solana-program` crate, not Anchor, so events are NOT `emit_cpi!`
 * self-CPI instructions. `programs/kakure_pool/src/events.rs` emits them with
 * `sol_log_data(&[tag_bytes, body_bytes])`, where `tag_bytes` is the ASCII string
 * `"kakure:<EventName>"` and `body_bytes` is `borsh::to_vec(&event)` with NO discriminator
 * prefix at all.
 *
 * Framing this decoder relies on (confirmed against `sol_log_data`'s actual behavior, not
 * assumed): the syscall logs one line per call, `"Program data: " + fields.map(base64).join(" ")`
 * -- i.e. EACH element of the slice passed to `sol_log_data` is base64-encoded SEPARATELY and
 * space-joined, not concatenated into one blob before encoding. So a `NoteInserted` emission
 * produces exactly one log line with exactly two base64 tokens: `base64("kakure:NoteInserted")`
 * and `base64(borsh(NoteInserted))`.
 */
export const PROGRAM_DATA_PREFIX = "Program data: ";
export const KAKURE_EVENT_TAG_PREFIX = "kakure:";

export class EventDecodeError extends Error {}

export interface DecodedEvent {
  name: string;
  /** Raw decoded fields keyed by their IDL (snake_case) field name. */
  fields: Record<string, unknown>;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) {
      throw new EventDecodeError("unexpected end of event data");
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u32(): number {
    const b = this.take(4);
    // slice-2 F-9 doc nit: `|` treats its operands as SIGNED 32-bit ints, so a value with the top
    // bit set (>= 2^31, e.g. `old_version`/`new_version` in ComplianceKeyRotated) would come back
    // negative. `>>> 0` reinterprets the result as unsigned -- irrelevant in practice (no real
    // version number reaches 2^31) but correct for the full u32 range.
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  u64(): bigint {
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) {
      value = (value << 8n) | BigInt(b[i]!);
    }
    return value;
  }

  bytes(n: number): Uint8Array {
    return Uint8Array.from(this.take(n));
  }

  atEnd(): boolean {
    return this.offset >= this.buf.length;
  }
}

function decodeValue(type: IdlType, reader: Reader): unknown {
  if (type === "u8") return reader.u8();
  if (type === "u16") throw new EventDecodeError("u16 decoding not implemented");
  if (type === "u32") return reader.u32();
  if (type === "u64") return reader.u64();
  if (type === "bool") return reader.u8() !== 0;
  if (typeof type === "object") {
    if ("array" in type) {
      const [elemType, len] = type.array;
      if (elemType === "u8") return reader.bytes(len);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) out.push(decodeValue(elemType, reader));
      return out;
    }
    if ("option" in type) {
      const tag = reader.u8();
      if (tag === 0) return null;
      if (tag === 1) return decodeValue(type.option, reader);
      throw new EventDecodeError(`invalid Option tag byte: ${tag}`);
    }
    if ("defined" in type) {
      throw new EventDecodeError(`unsupported defined type reference: ${type.defined}`);
    }
  }
  throw new EventDecodeError(`unsupported IDL type: ${JSON.stringify(type)}`);
}

function decodeBody(idl: KakurePoolIdl, eventName: string, body: Uint8Array): DecodedEvent {
  const typeDef = idl.types.find((t) => t.name === eventName);
  if (!typeDef) {
    throw new EventDecodeError(`IDL has no type definition for event '${eventName}'`);
  }
  const reader = new Reader(body);
  const fields: Record<string, unknown> = {};
  for (const field of typeDef.type.fields) {
    fields[field.name] = decodeValue(field.type, reader);
  }
  return { name: eventName, fields };
}

/**
 * Decodes one raw `sol_log_data` call already split into its base64-encoded fields (i.e. the
 * tokens of a `"Program data: <tag> <body>"` log line, after the prefix, split on whitespace).
 * Throws `EventDecodeError` for anything malformed. Used directly by tests that want to bypass
 * log-line parsing; `decodeProgramDataLine` below is what the ingestor actually calls.
 */
export function decodeSolLogDataFields(idl: KakurePoolIdl, fields: readonly string[]): DecodedEvent {
  if (fields.length < 2) {
    throw new EventDecodeError(
      `sol_log_data event needs at least 2 base64 fields (tag, body), got ${fields.length}`,
    );
  }
  let tagBytes: Buffer;
  let bodyBytes: Buffer;
  try {
    tagBytes = Buffer.from(fields[0]!, "base64");
    bodyBytes = Buffer.from(fields[1]!, "base64");
  } catch {
    throw new EventDecodeError("malformed base64 in sol_log_data fields");
  }
  const tag = tagBytes.toString("utf8");
  if (!tag.startsWith(KAKURE_EVENT_TAG_PREFIX)) {
    throw new EventDecodeError(`not a kakure event tag: '${tag}'`);
  }
  const eventName = tag.slice(KAKURE_EVENT_TAG_PREFIX.length);
  return decodeBody(idl, eventName, bodyBytes);
}

/**
 * Decodes a single program-log line if it is a `sol_log_data`-produced `"Program data: ..."`
 * line carrying a recognized `kakure:` event tag; returns `null` for any line that is not a
 * `"Program data: "` line at all (nothing to decode, not an error). Throws `EventDecodeError`
 * for a `"Program data: "` line that IS malformed or carries a tag/body this decoder cannot
 * make sense of (unknown event name, truncated body, etc).
 */
export function decodeProgramDataLine(idl: KakurePoolIdl, line: string): DecodedEvent | null {
  if (!line.startsWith(PROGRAM_DATA_PREFIX)) return null;
  const fields = line.slice(PROGRAM_DATA_PREFIX.length).trim().split(/\s+/);
  return decodeSolLogDataFields(idl, fields);
}
