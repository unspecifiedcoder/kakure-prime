import { describe, expect, it } from "vitest";
import { programDataLinesFor } from "./logScope.js";
import { noteInsertedLogLine, wrapInProgramInvocation } from "../__tests__/fixtures/events.js";

const POOL = "Poo1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111";

describe("programDataLinesFor", () => {
  it("keeps a Program data line emitted while the pool program is on top of the invoke stack", () => {
    const line = noteInsertedLogLine({ leafIndex: 0n, leafByte: 1 });
    const logs = wrapInProgramInvocation(POOL, [line]);
    expect(programDataLinesFor(logs, POOL)).toEqual([line]);
  });

  it("drops a Program data line emitted by a different (e.g. CPI'd) program", () => {
    const line = noteInsertedLogLine({ leafIndex: 0n, leafByte: 1 });
    const logs = wrapInProgramInvocation(OTHER, [line]);
    expect(programDataLinesFor(logs, POOL)).toEqual([]);
  });

  it("attributes a nested CPI's Program data line to the CPI'd program, not the outer one", () => {
    const outerLine = noteInsertedLogLine({ leafIndex: 0n, leafByte: 1 });
    const innerLine = noteInsertedLogLine({ leafIndex: 1n, leafByte: 2 });
    const logs = [
      `Program ${POOL} invoke [1]`,
      outerLine,
      `Program ${OTHER} invoke [2]`,
      innerLine,
      `Program ${OTHER} success`,
      `Program ${POOL} success`,
    ];
    expect(programDataLinesFor(logs, POOL)).toEqual([outerLine]);
    expect(programDataLinesFor(logs, OTHER)).toEqual([innerLine]);
  });

  it("handles a failed inner invocation's end marker", () => {
    const line = noteInsertedLogLine({ leafIndex: 0n, leafByte: 1 });
    const logs = [
      `Program ${POOL} invoke [1]`,
      `Program ${OTHER} invoke [2]`,
      `Program ${OTHER} failed: custom program error: 0x1`,
      line,
      `Program ${POOL} success`,
    ];
    expect(programDataLinesFor(logs, POOL)).toEqual([line]);
  });

  it("returns an empty array for logs with no Program data lines", () => {
    expect(programDataLinesFor([`Program ${POOL} invoke [1]`, "Program log: hi", `Program ${POOL} success`], POOL)).toEqual([]);
  });
});
