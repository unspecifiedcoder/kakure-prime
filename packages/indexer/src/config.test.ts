import { describe, expect, it } from "vitest";
import { parseArgs } from "./config.js";

describe("parseArgs", () => {
  it("parses all flags", () => {
    const cfg = parseArgs([
      "--port",
      "9000",
      "--rpc",
      "http://example.com",
      "--program-id",
      "Pool111",
      "--idl",
      "./idl.json",
      "--db",
      "./db.sqlite",
    ]);
    expect(cfg).toEqual({
      port: 9000,
      rpcUrl: "http://example.com",
      programId: "Pool111",
      idlPath: "./idl.json",
      dbPath: "./db.sqlite",
      host: "127.0.0.1",
    });
  });

  it("applies defaults for port, rpc and db", () => {
    const cfg = parseArgs(["--program-id", "Pool111", "--idl", "./idl.json"]);
    expect(cfg.port).toBe(8787);
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(cfg.dbPath).toBe("./kakure-indexer.sqlite");
    expect(cfg.host).toBe("127.0.0.1"); // slice-2 F-8: loopback by default, not 0.0.0.0
  });

  // slice-2 F-8
  it("--host overrides the loopback default", () => {
    expect(
      parseArgs(["--program-id", "Pool111", "--idl", "./idl.json", "--host", "0.0.0.0"]).host,
    ).toBe("0.0.0.0");
  });

  it("requires --program-id", () => {
    expect(() => parseArgs(["--idl", "./idl.json"])).toThrow(/program-id/);
  });

  it("requires --idl", () => {
    expect(() => parseArgs(["--program-id", "Pool111"])).toThrow(/idl/);
  });

  it("rejects a non-positive port", () => {
    expect(() =>
      parseArgs(["--port", "0", "--program-id", "Pool111", "--idl", "./idl.json"]),
    ).toThrow(/port/);
  });
});
