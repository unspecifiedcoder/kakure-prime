import { describe, expect, it } from "vitest";
import { INDEXER_PACKAGE_NAME } from "./index.js";

describe("package scaffold", () => {
  it("exports a package name constant", () => {
    expect(INDEXER_PACKAGE_NAME).toBe("@kakure/indexer");
  });
});
