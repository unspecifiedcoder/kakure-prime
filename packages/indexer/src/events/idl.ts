/**
 * Minimal local mirror of the subset of the Anchor IDL JSON schema this decoder needs
 * (events + the struct type definitions their fields reference). Shaped to be a drop-in
 * subset of a real Anchor-generated IDL, so swapping in `kakure_pool`'s actual IDL (workstream B,
 * `programs/kakure_pool/target/idl/kakure_pool.json`) requires no code changes here — only pointing
 * `--idl` at the real file.
 */
export type IdlType =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "bool"
  | { array: [IdlType, number] }
  | { option: IdlType }
  | { defined: string };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlTypeDef {
  name: string;
  type: { kind: "struct"; fields: IdlField[] };
}

export interface IdlEvent {
  name: string;
  /** Optional explicit 8-byte discriminator (as a real Anchor IDL provides); computed from
   *  `sha256("event:<name>")[0..8]` when absent. */
  discriminator?: number[];
}

export interface KakurePoolIdl {
  events: IdlEvent[];
  types: IdlTypeDef[];
}

/**
 * Local mirror of the `kakure_pool` events IDL (spec §4, plan I-4). Used as the default IDL when
 * no `--idl` file is configured, and as the fixture shape for indexer tests.
 *
 * TODO(integration): replace with the real IDL published by workstream B once available — load it
 * from the `--idl` path instead of depending on this constant.
 */
export const DEFAULT_KAKURE_POOL_IDL: KakurePoolIdl = {
  events: [{ name: "NoteInserted" }, { name: "NullifierSpent" }, { name: "ComplianceKeyRotated" }],
  types: [
    {
      name: "NoteInserted",
      type: {
        kind: "struct",
        fields: [
          { name: "leaf_index", type: "u64" },
          { name: "leaf", type: { array: ["u8", 32] } },
          { name: "eph_pub_x", type: { array: ["u8", 32] } },
          { name: "tag", type: { option: { array: ["u8", 32] } } },
          { name: "cek_wrap", type: { option: { array: ["u8", 32] } } },
          { name: "ciphertext", type: { array: [{ array: ["u8", 32] }, 7] } },
          { name: "root", type: { array: ["u8", 32] } },
        ],
      },
    },
    {
      name: "NullifierSpent",
      type: { kind: "struct", fields: [{ name: "nullifier", type: { array: ["u8", 32] } }] },
    },
    {
      name: "ComplianceKeyRotated",
      type: {
        kind: "struct",
        fields: [
          { name: "old_version", type: "u32" },
          { name: "new_version", type: "u32" },
          { name: "x", type: { array: ["u8", 32] } },
          { name: "y", type: { array: ["u8", 32] } },
        ],
      },
    },
  ],
};
