/** Builds the raw borsh body bytes and full `sol_log_data` program-log lines for `kakure_pool`'s
 *  events (I-4), matching `programs/kakure_pool/src/events.rs`'s
 *  `sol_log_data(&[tag_bytes, body_bytes])` framing: one log line per event, "Program data: "
 *  followed by each field base64-encoded SEPARATELY and space-joined (not concatenated then
 *  encoded as one blob). */

function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

function u32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function filled32(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function solLogDataLine(tag: string, body: Buffer): string {
  const tagB64 = Buffer.from(tag, "utf8").toString("base64");
  const bodyB64 = body.toString("base64");
  return `Program data: ${tagB64} ${bodyB64}`;
}

/** A `"Program data: "` log line for a `NoteInserted` event (I-4), tag/cek_wrap = None. */
export function noteInsertedLogLine(opts: { leafIndex: bigint; leafByte: number }): string {
  const body = Buffer.concat([
    u64le(opts.leafIndex),
    filled32(opts.leafByte), // leaf
    filled32(0x02), // eph_pub_x
    Buffer.from([0]), // tag: None
    Buffer.from([0]), // cek_wrap: None
    Buffer.concat(Array.from({ length: 7 }, () => filled32(0x00))), // ciphertext[7]
    filled32(0x00), // root (unused by the decoder's consumer -- the tree computes its own root)
  ]);
  return solLogDataLine("kakure:NoteInserted", body);
}

/** A `"Program data: "` log line for a `NullifierSpent` event (I-4). */
export function nullifierSpentLogLine(nullifierByte: number): string {
  return solLogDataLine("kakure:NullifierSpent", filled32(nullifierByte));
}

/** A `"Program data: "` log line for a `ComplianceKeyRotated` event (I-4). */
export function complianceKeyRotatedLogLine(opts: {
  oldVersion: number;
  newVersion: number;
  xByte: number;
  yByte: number;
}): string {
  const body = Buffer.concat([
    u32le(opts.oldVersion),
    u32le(opts.newVersion),
    filled32(opts.xByte),
    filled32(opts.yByte),
  ]);
  return solLogDataLine("kakure:ComplianceKeyRotated", body);
}

/** Wraps one or more `"Program data: "` lines in the invoke/success bracket a real transaction's
 *  `meta.logMessages` would carry, so tests exercise `logScope.ts`'s program-id scoping too. */
export function wrapInProgramInvocation(programId: string, lines: string[], depth = 1): string[] {
  return [`Program ${programId} invoke [${depth}]`, ...lines, `Program ${programId} success`];
}
