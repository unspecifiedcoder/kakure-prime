import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { SolanaAccount } from "@kakure/sdk";
import * as walletLib from "../lib/wallet.js";
import * as treasuryLib from "../lib/treasury.js";
import { useAppStore } from "../store/appStore.js";
import { Home } from "./Home.js";

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ walletPublicKey: null, account: null, treasuries: [] });
});

describe("Home (spec §1.1: connect, create/join a private treasury)", () => {
  it("shows a connect button when no wallet is connected, and no treasuries yet", () => {
    renderHome();
    expect(screen.getByRole("button", { name: /enter private markets/i })).toBeInTheDocument();
    expect(screen.getByText(/no private portfolios yet/i)).toBeInTheDocument();
  });

  it("links both submission videos from the hero", () => {
    renderHome();
    expect(screen.getByRole("link", { name: /watch pitch video/i })).toHaveAttribute("href", "/pitch-video.html");
    expect(screen.getByRole("link", { name: /technical walkthrough/i })).toHaveAttribute("href", "/demo-video.html");
  });

  it("connecting derives the account and shows the wallet address instead of the connect button", async () => {
    const account = await SolanaAccount.fromSeed("home-test-seed");
    vi.spyOn(walletLib, "connectPhantom").mockResolvedValue({
      publicKey: PublicKey.default,
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    });
    vi.spyOn(walletLib, "deriveAccount").mockResolvedValue(account);

    renderHome();
    screen.getByRole("button", { name: /enter private markets/i }).click();
    await waitFor(() => expect(screen.getByText(/connected:/i)).toBeInTheDocument());
  });

  it("creating a treasury runs the ceremony and shows an invite link on success", async () => {
    const record = {
      sessionId: "s".repeat(64),
      name: "Payroll ops",
      threshold: 3,
      memberCount: 5,
      myId: "1",
      participantIds: ["1", "2", "3", "4", "5"],
      gpk: { x: "1", y: "2" },
      mySecretShare: "42",
      groupViewKey: { gvs: "1", v: "1", V: { x: "1", y: "1" }, roll: "1" },
      dealerCommitments: {},
      ceremonyKeypairSecretB64: "",
    };
    const createSpy = vi.spyOn(treasuryLib, "createOrJoinTreasury").mockResolvedValue(record);

    renderHome();
    screen.getByLabelText(/^name$/i).setAttribute("value", "Payroll ops");
    // fireEvent-free minimal interaction: directly invoke the button; name field default empty is fine for this test
    screen.getByRole("button", { name: /^create$/i }).click();

    await waitFor(() => expect(screen.getByText(/treasury ready/i)).toBeInTheDocument());
    expect(createSpy).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /open treasury/i })).toBeInTheDocument();
  });

  it("a failed ceremony shows the error instead of silently doing nothing", async () => {
    vi.spyOn(treasuryLib, "createOrJoinTreasury").mockRejectedValue(new Error("coordinator unreachable"));
    renderHome();
    screen.getByRole("button", { name: /^create$/i }).click();
    await waitFor(() => expect(screen.getByText(/coordinator unreachable/i)).toBeInTheDocument());
  });

  it("never renders a spend-key/secret-key/seed-phrase input on the home page", () => {
    renderHome();
    const inputs = document.querySelectorAll("input");
    for (const input of Array.from(inputs)) {
      const label = document.querySelector(`label[for="${input.id}"]`)?.textContent ?? "";
      expect(`${input.id} ${label}`.toLowerCase()).not.toMatch(/spend[- ]?key|secret[- ]?key|seed phrase|mnemonic/);
    }
  });
});
