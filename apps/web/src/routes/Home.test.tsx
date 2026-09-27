import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  it("shows the empty private-portfolio state", () => {
    renderHome();
    expect(screen.getByText(/no private portfolios yet/i)).toBeInTheDocument();
  });

  it("links the pitch and finalized evidence from the hero", () => {
    renderHome();
    expect(screen.getByRole("link", { name: /watch pitch video/i })).toHaveAttribute("href", "/pitch-video.html");
    expect(screen.getByRole("link", { name: /inspect devnet proof/i })).toHaveAttribute("href", "/evidence");
  });

  it("puts the finalized private Devnet lifecycle above the fold", () => {
    renderHome();
    expect(screen.getByText(/public devnet · 9 \/ 9 pass/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /private 3-of-5/i })).toHaveAttribute(
      "href",
      expect.stringContaining("2EyosmdTjZ3c7DsgQRBHhGexfEM6JGhGxk1XFJLeAyooPkvuX8yP2iqJjJucC3DeyZqXpeKmgPEvtt13Pqjknwsg"),
    );
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
