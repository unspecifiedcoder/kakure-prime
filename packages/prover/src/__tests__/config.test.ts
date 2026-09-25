import { resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { resolveArtifactsDir, resolveSunspotBin } from "../config.js";

describe("resolveArtifactsDir", () => {
  const original = process.env.KAKURE_ARTIFACTS_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.KAKURE_ARTIFACTS_DIR;
    else process.env.KAKURE_ARTIFACTS_DIR = original;
  });

  it("defaults to circuits/target relative to cwd", () => {
    delete process.env.KAKURE_ARTIFACTS_DIR;
    expect(resolveArtifactsDir()).toBe(resolve("circuits/target"));
  });

  it("honours KAKURE_ARTIFACTS_DIR", () => {
    process.env.KAKURE_ARTIFACTS_DIR = "/tmp/some-dir";
    expect(resolveArtifactsDir()).toBe(resolve("/tmp/some-dir"));
  });

  it("prefers an explicit override over the env var", () => {
    process.env.KAKURE_ARTIFACTS_DIR = "/tmp/env-dir";
    expect(resolveArtifactsDir("/tmp/explicit-dir")).toBe(
      resolve("/tmp/explicit-dir"),
    );
  });
});

describe("resolveSunspotBin", () => {
  it("defaults to /usr/local/bin/sunspot", () => {
    delete process.env.SUNSPOT_BIN;
    expect(resolveSunspotBin()).toBe("/usr/local/bin/sunspot");
  });

  it("honours an explicit override", () => {
    expect(resolveSunspotBin("/opt/sunspot")).toBe("/opt/sunspot");
  });
});
