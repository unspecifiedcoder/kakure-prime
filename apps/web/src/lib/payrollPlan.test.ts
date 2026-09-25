import { describe, it, expect } from "vitest";
import { parsePayrollCsv, totalAmount, PayrollParseError } from "./payrollPlan.js";
import { encodeReceiveAddress } from "./receiveAddress.js";

describe("parsePayrollCsv (spec §1.1: CSV/table -> N transfer_multisig rows)", () => {
  const addr1 = encodeReceiveAddress({ index: 0n, pubX: 1n, pubY: 2n });
  const addr2 = encodeReceiveAddress({ index: 0n, pubX: 3n, pubY: 4n });
  const addr3 = encodeReceiveAddress({ index: 1n, pubX: 5n, pubY: 6n });

  it("parses address,amount,memo rows", () => {
    const rows = parsePayrollCsv(`${addr1},1000,rent\n${addr2},2500,contractor payment`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ address: addr1, amount: 1000n, memo: "rent", status: "pending" });
    expect(rows[1]!.amount).toBe(2500n);
  });

  it("skips a header row when its first cell is not a valid pay address", () => {
    const rows = parsePayrollCsv(`address,amount,memo\n${addr1},1000,rent`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(addr1);
  });

  it("supports amount-only rows (memo optional)", () => {
    const rows = parsePayrollCsv(`${addr1},1000`);
    expect(rows[0]!.memo).toBe("");
  });

  it("ignores blank lines", () => {
    const rows = parsePayrollCsv(`${addr1},1000,a\n\n${addr2},2000,b\n`);
    expect(rows).toHaveLength(2);
  });

  it("rejects an invalid address with a line number", () => {
    expect(() => parsePayrollCsv(`not-an-address,1000,rent`)).toThrow(PayrollParseError);
    try {
      parsePayrollCsv(`${addr1},1000,ok\nnot-an-address,1000,rent`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PayrollParseError);
      expect((err as PayrollParseError).lineErrors).toEqual([{ line: 2, message: expect.stringContaining("not a valid") }]);
    }
  });

  it("rejects a zero, negative, or non-integer amount", () => {
    expect(() => parsePayrollCsv(`${addr1},0,x`)).toThrow(PayrollParseError);
    expect(() => parsePayrollCsv(`${addr1},-5,x`)).toThrow(PayrollParseError);
    expect(() => parsePayrollCsv(`${addr1},12.5,x`)).toThrow(PayrollParseError);
  });

  it("totalAmount sums every row's amount", () => {
    const rows = parsePayrollCsv(`${addr1},1000,a\n${addr2},2000,b\n${addr3},3000,c`);
    expect(totalAmount(rows)).toBe(6000n);
  });
});
