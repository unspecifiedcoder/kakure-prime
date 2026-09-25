import { describe, expect, it } from "vitest";
import { buildCli } from "../cli.js";

describe("kakure --help", () => {
  it("lists every top-level command via commander's own help text (no subprocess)", () => {
    const program = buildCli();
    const help = program.helpInformation();
    for (const name of ["keygen", "group", "balance", "deposit", "propose", "sign"]) {
      expect(help).toContain(name);
    }
  });

  it("group subcommand lists create and join", () => {
    const program = buildCli();
    const group = program.commands.find((c) => c.name() === "group");
    expect(group).toBeDefined();
    const help = group!.helpInformation();
    expect(help).toContain("create");
    expect(help).toContain("join");
  });

  it("propose subcommand lists transfer/split/join/withdraw", () => {
    const program = buildCli();
    const propose = program.commands.find((c) => c.name() === "propose");
    expect(propose).toBeDefined();
    const names = propose!.commands.map((c) => c.name());
    expect(names).toEqual(["transfer", "split", "join", "withdraw"]);
  });
});
