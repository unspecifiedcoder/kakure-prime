import { describe, expect, it } from "vitest";
import { COORDINATOR_PACKAGE_NAME } from "./index.js";

describe("package scaffold", () => {
  it("exports a package name constant", () => {
    expect(COORDINATOR_PACKAGE_NAME).toBe("@kakure/coordinator");
  });
});
