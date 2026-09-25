import { describe, expect, it } from "vitest";
import { parseArgs } from "./config.js";

describe("parseArgs", () => {
  it("parses flags", () => {
    expect(parseArgs(["--port", "9001", "--db", "./x.sqlite"])).toEqual({
      port: 9001,
      dbPath: "./x.sqlite",
      host: "127.0.0.1",
    });
  });

  it("applies defaults", () => {
    const cfg = parseArgs([]);
    expect(cfg.port).toBe(8788);
    expect(cfg.dbPath).toBe("./kakure-coordinator.sqlite");
    expect(cfg.host).toBe("127.0.0.1"); // slice-2 F-8: loopback by default, not 0.0.0.0
  });

  it("rejects a non-positive port", () => {
    expect(() => parseArgs(["--port", "-1"])).toThrow(/port/);
  });

  // slice-2 F-8
  it("--host overrides the loopback default", () => {
    expect(parseArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
  });
});
