import { describe, it, expect, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { SolanaAccount } from "@kakure/sdk";
import { useAppStore } from "./appStore.js";

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    walletPublicKey: null,
    account: null,
    treasuries: [],
  });
});

describe("appStore", () => {
  it("starts disconnected with default local settings", () => {
    const state = useAppStore.getState();
    expect(state.walletPublicKey).toBeNull();
    expect(state.settings.indexerUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("connect()/disconnect() hold wallet+account only in memory", async () => {
    const account = await SolanaAccount.fromSeed("test-seed");
    const pubkey = PublicKey.default;
    useAppStore.getState().connect(pubkey, account);
    expect(useAppStore.getState().walletPublicKey).toBe(pubkey);
    expect(useAppStore.getState().account).toBe(account);

    useAppStore.getState().disconnect();
    expect(useAppStore.getState().walletPublicKey).toBeNull();
    expect(useAppStore.getState().account).toBeNull();
  });

  it("updateSettings persists non-secret prefs to localStorage but never the helper token (spec §3B: per-launch secret)", () => {
    useAppStore.getState().updateSettings({ helperToken: "abc123", programId: "Prog111" });
    expect(useAppStore.getState().settings.helperToken).toBe("abc123");
    const raw = localStorage.getItem("kakure.web.settings.v1");
    expect(raw).toContain("Prog111");
    expect(raw).not.toContain("abc123");
  });

  it("add/removeTreasury manage the non-secret treasury list", () => {
    useAppStore.getState().addTreasury({ id: "t1", name: "Payroll", threshold: 3, signerCount: 5 });
    expect(useAppStore.getState().treasuries).toHaveLength(1);
    useAppStore.getState().removeTreasury("t1");
    expect(useAppStore.getState().treasuries).toHaveLength(0);
  });
});
