import type { DecodedEvent } from "./decode.js";
import { EventDecodeError } from "./decode.js";

/** Domain shapes for I-4 events, hex-encoded (`0x`-prefixed, big-endian) for storage/API use. */
export interface NoteInsertedEvent {
  name: "NoteInserted";
  leafIndex: bigint;
  leaf: string;
  ephPubX: string;
  tag: string | null;
  cekWrap: string | null;
  ciphertext: string[]; // 7 entries
  root: string;
}

export interface NullifierSpentEvent {
  name: "NullifierSpent";
  nullifier: string;
}

export interface ComplianceKeyRotatedEvent {
  name: "ComplianceKeyRotated";
  oldVersion: number;
  newVersion: number;
  x: string;
  y: string;
}

export type KakurePoolEvent =
  | NoteInsertedEvent
  | NullifierSpentEvent
  | ComplianceKeyRotatedEvent;

function toHex(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new EventDecodeError("expected a byte array field");
  }
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function toHexOrNull(bytes: unknown): string | null {
  return bytes === null ? null : toHex(bytes);
}

function toHexArray(values: unknown): string[] {
  if (!Array.isArray(values)) throw new EventDecodeError("expected an array field");
  return values.map((v) => toHex(v));
}

/** Map a generic `DecodedEvent` to its typed, hex-encoded domain representation. */
export function toDomainEvent(decoded: DecodedEvent): KakurePoolEvent {
  switch (decoded.name) {
    case "NoteInserted":
      return {
        name: "NoteInserted",
        leafIndex: decoded.fields["leaf_index"] as bigint,
        leaf: toHex(decoded.fields["leaf"]),
        ephPubX: toHex(decoded.fields["eph_pub_x"]),
        tag: toHexOrNull(decoded.fields["tag"]),
        cekWrap: toHexOrNull(decoded.fields["cek_wrap"]),
        ciphertext: toHexArray(decoded.fields["ciphertext"]),
        root: toHex(decoded.fields["root"]),
      };
    case "NullifierSpent":
      return {
        name: "NullifierSpent",
        nullifier: toHex(decoded.fields["nullifier"]),
      };
    case "ComplianceKeyRotated":
      return {
        name: "ComplianceKeyRotated",
        oldVersion: decoded.fields["old_version"] as number,
        newVersion: decoded.fields["new_version"] as number,
        x: toHex(decoded.fields["x"]),
        y: toHex(decoded.fields["y"]),
      };
    default:
      throw new EventDecodeError(`no domain mapping for event '${decoded.name}'`);
  }
}
