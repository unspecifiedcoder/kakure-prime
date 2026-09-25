import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config.js";

describe("config", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kakure-config-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig(join(dir, "config.json"));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips a saved config, merging over defaults", async () => {
    const path = join(dir, "config.json");
    await saveConfig({ ...DEFAULT_CONFIG, programId: "SomeProgramId1111111111111111111111111111" }, path);
    const loaded = await loadConfig(path);
    expect(loaded.programId).toBe("SomeProgramId1111111111111111111111111111");
    expect(loaded.network).toBe(DEFAULT_CONFIG.network);
  });
});
