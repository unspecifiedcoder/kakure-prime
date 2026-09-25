/**
 * Minimal hand-rolled borsh encode/decode helpers for `kakure_pool`'s wire format.
 *
 * `kakure_pool` is a native `solana-program` crate, not Anchor (see
 * `programs/kakure_pool/src/instruction.rs`'s file doc): instruction data is
 * `borsh::to_vec(&PoolInstruction)` -- a single leading `u8` variant tag (0-based declaration
 * order) followed by the borsh encoding of that variant's fields, NOT Anchor's 8-byte sighash
 * discriminator. `@coral-xyz/anchor`'s `BorshInstructionCoder` assumes the latter, so it cannot
 * encode/decode this program's instructions; these helpers exist instead.
 */
import { PublicKey } from "@solana/web3.js";

export class BorshWriter {
  private readonly chunks: Buffer[] = [];

  u8(v: number): this {
    this.chunks.push(Buffer.from([v & 0xff]));
    return this;
  }

  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.chunks.push(b);
    return this;
  }

  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    this.chunks.push(b);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  /** Raw fixed-size bytes (borsh fixed arrays carry no length prefix). */
  bytes(v: Uint8Array): this {
    this.chunks.push(Buffer.from(v));
    return this;
  }

  pubkey(v: PublicKey): this {
    return this.bytes(v.toBytes());
  }

  /** `Vec<u8>`: u32 LE length prefix + raw bytes. */
  vecU8(v: Uint8Array): this {
    this.u32(v.length);
    return this.bytes(v);
  }

  /** `Vec<[u8;32]>`: u32 LE length prefix + N * 32 raw bytes. */
  vecFixed32(vs: readonly Uint8Array[]): this {
    this.u32(vs.length);
    for (const v of vs) {
      if (v.length !== 32) {
        throw new Error(`BorshWriter.vecFixed32: expected 32-byte elements, got ${v.length}`);
      }
      this.bytes(v);
    }
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class BorshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  private need(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new Error(
        `BorshReader: unexpected end of data (need ${n} bytes at offset ${this.offset}, have ${this.data.length})`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.data[this.offset]!;
    this.offset += 1;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }

  pubkey(): PublicKey {
    return new PublicKey(this.bytes(32));
  }

  remaining(): number {
    return this.data.length - this.offset;
  }
}
