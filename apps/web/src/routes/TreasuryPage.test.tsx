import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as keystoreLib from "../lib/keystore.js";
import { encodeReceiveAddress } from "../lib/receiveAddress.js";
import type { GroupRecord } from "../lib/treasury.js";
import { TreasuryPage } from "./TreasuryPage.js";

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/treasury/${id}`]}>
      <Routes>
        <Route path="/treasury/:id" element={<TreasuryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fakeGroup(): GroupRecord {
  return {
    sessionId: "t".repeat(64),
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
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("TreasuryPage (spec §1.1: Fund / Pay people / Balances / Settings)", () => {
  it("starts locked, asking only for a passphrase (no other secret field)", () => {
    renderAt("abc");
    expect(screen.getByText(/unlock treasury/i)).toBeInTheDocument();
    const inputs = document.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.getAttribute("type")).toBe("password");
  });

  it("shows the unlock error when the passphrase is wrong instead of silently failing", async () => {
    vi.spyOn(keystoreLib, "loadEncrypted").mockRejectedValue(new Error("wrong passphrase"));
    renderAt("abc");
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText(/wrong passphrase/i)).toBeInTheDocument());
  });

  it("unlocking reveals the Fund/Pay people/Balances/Settings tabs", async () => {
    vi.spyOn(keystoreLib, "loadEncrypted").mockResolvedValue(fakeGroup());
    renderAt("abc");
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText(/payroll ops/i)).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /^fund$/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pay people/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /balances/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /settings/i })).toBeInTheDocument();
  });

  it("Pay people tab: previewing a CSV shows a row per recipient and the total", async () => {
    vi.spyOn(keystoreLib, "loadEncrypted").mockResolvedValue(fakeGroup());
    renderAt("abc");
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => screen.getByRole("tab", { name: /pay people/i }));
    fireEvent.click(screen.getByRole("tab", { name: /pay people/i }));
    await waitFor(() => screen.getByLabelText(/recipients/i));

    const addr1 = encodeReceiveAddress({ index: 0n, pubX: 1n, pubY: 2n });
    const addr2 = encodeReceiveAddress({ index: 0n, pubX: 3n, pubY: 4n });
    const textarea = screen.getByLabelText(/recipients/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: `${addr1},1000,alice\n${addr2},2000,bob` } });
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(screen.getByText(/total: 3000/i)).toBeInTheDocument());
    expect(screen.getAllByText(/pending/i).length).toBeGreaterThan(0);
  });

  it("Pay people tab: an invalid CSV row shows the parse error, not a crash", async () => {
    vi.spyOn(keystoreLib, "loadEncrypted").mockResolvedValue(fakeGroup());
    renderAt("abc");
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => screen.getByRole("tab", { name: /pay people/i }));
    fireEvent.click(screen.getByRole("tab", { name: /pay people/i }));
    await waitFor(() => screen.getByLabelText(/recipients/i));

    const textarea = screen.getByLabelText(/recipients/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "not-a-valid-address,1000,x" } });
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("never renders a spend-key, FROST secret-share, or seed-phrase input anywhere on this page", async () => {
    vi.spyOn(keystoreLib, "loadEncrypted").mockResolvedValue(fakeGroup());
    renderAt("abc");
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => screen.getByText(/payroll ops/i));

    const inputs = document.querySelectorAll("input");
    for (const input of Array.from(inputs)) {
      const label = document.querySelector(`label[for="${input.id}"]`)?.textContent ?? "";
      expect(`${input.id} ${label}`.toLowerCase()).not.toMatch(
        /spend[- ]?key|secret[- ]?share|frost|seed phrase|mnemonic/,
      );
    }
  });
});
