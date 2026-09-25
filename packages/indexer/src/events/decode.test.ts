import { describe, expect, it } from "vitest";
import { DEFAULT_KAKURE_POOL_IDL } from "./idl.js";
import { EventDecodeError, decodeProgramDataLine, decodeSolLogDataFields } from "./decode.js";
import { toDomainEvent } from "./types.js";
import {
  complianceKeyRotatedLogLine,
  noteInsertedLogLine,
  nullifierSpentLogLine,
} from "../__tests__/fixtures/events.js";

describe("decodeProgramDataLine / decodeSolLogDataFields", () => {
  it("decodes a NoteInserted event (tag/cek_wrap absent, None)", () => {
    const line = noteInsertedLogLine({ leafIndex: 7n, leafByte: 0x01 });
    const decoded = decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, line);
    expect(decoded?.name).toBe("NoteInserted");

    const domain = toDomainEvent(decoded!);
    expect(domain).toMatchObject({
      name: "NoteInserted",
      leafIndex: 7n,
      leaf: `0x${"01".repeat(32)}`,
      tag: null,
      cekWrap: null,
    });
  });

  it("decodes a NullifierSpent event", () => {
    const line = nullifierSpentLogLine(0x09);
    const domain = toDomainEvent(decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, line)!);
    expect(domain).toEqual({ name: "NullifierSpent", nullifier: `0x${"09".repeat(32)}` });
  });

  it("decodes a ComplianceKeyRotated event", () => {
    const line = complianceKeyRotatedLogLine({ oldVersion: 0, newVersion: 1, xByte: 0x0a, yByte: 0x0b });
    const domain = toDomainEvent(decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, line)!);
    expect(domain).toEqual({
      name: "ComplianceKeyRotated",
      oldVersion: 0,
      newVersion: 1,
      x: `0x${"0a".repeat(32)}`,
      y: `0x${"0b".repeat(32)}`,
    });
  });

  it("decodes tag and body as SEPARATE base64 fields, space-joined (sol_log_data's real framing)", () => {
    // Regression guard for the framing this decoder depends on: if sol_log_data instead
    // concatenated the fields before base64-encoding (a plausible but wrong assumption), a
    // single base64 blob would not split on whitespace into two valid fields the way this does.
    const tagB64 = Buffer.from("kakure:NullifierSpent", "utf8").toString("base64");
    const bodyB64 = Buffer.alloc(32, 0x42).toString("base64");
    const decoded = decodeSolLogDataFields(DEFAULT_KAKURE_POOL_IDL, [tagB64, bodyB64]);
    expect(decoded.name).toBe("NullifierSpent");
  });

  it("returns null for a log line that is not \"Program data: \" at all", () => {
    expect(decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, "Program log: hello")).toBeNull();
    expect(
      decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, "Program 11111111111111111111111111111111111111111 success"),
    ).toBeNull();
  });

  it("rejects a Program data line with fewer than 2 fields", () => {
    const tagB64 = Buffer.from("kakure:NullifierSpent", "utf8").toString("base64");
    expect(() =>
      decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, `Program data: ${tagB64}`),
    ).toThrow(EventDecodeError);
  });

  it("rejects an unrecognized tag prefix (not a kakure: event)", () => {
    const tagB64 = Buffer.from("anchor:SomeOtherEvent", "utf8").toString("base64");
    const bodyB64 = Buffer.alloc(4).toString("base64");
    expect(() =>
      decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, `Program data: ${tagB64} ${bodyB64}`),
    ).toThrow(EventDecodeError);
  });

  it("rejects an unknown kakure event name", () => {
    const tagB64 = Buffer.from("kakure:NotARealEvent", "utf8").toString("base64");
    const bodyB64 = Buffer.alloc(4).toString("base64");
    expect(() =>
      decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, `Program data: ${tagB64} ${bodyB64}`),
    ).toThrow(EventDecodeError);
  });

  it("rejects truncated event bodies", () => {
    const tagB64 = Buffer.from("kakure:NullifierSpent", "utf8").toString("base64");
    const bodyB64 = Buffer.alloc(4).toString("base64"); // nullifier needs 32 bytes
    expect(() =>
      decodeProgramDataLine(DEFAULT_KAKURE_POOL_IDL, `Program data: ${tagB64} ${bodyB64}`),
    ).toThrow(EventDecodeError);
  });
});
