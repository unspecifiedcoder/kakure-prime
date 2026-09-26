import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { encodeClaimToken } from "../lib/claimToken.js";
import * as walletLib from "../lib/wallet.js";
import * as scanLib from "../lib/singleKeyScan.js";
import * as proverRouter from "../prover/router.js";
import * as claimFlows from "../lib/claimFlows.js";
import { ClaimPage } from "./ClaimPage.js";
import { SolanaAccount } from "@kakure/sdk";
import { PublicKey } from "@solana/web3.js";

async function connectAndFindPayment(token: string): Promise<void> {
  const account = await SolanaAccount.fromSeed("claim-progress-seed");
  vi.spyOn(walletLib, "connectPreferredWallet").mockResolvedValue({
    publicKey: PublicKey.default,
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
  });
  vi.spyOn(walletLib, "deriveAccount").mockResolvedValue(account);
  vi.spyOn(scanLib, "scanSingleKey").mockResolvedValue({
    notes: [
      { leafIndex: 6, note: { value: 500n, assetId: { toBigInt: () => 1n } }, nullifier: { toString: () => "0xabc" }, isIncoming: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    balances: [],
  });
  renderAt(token);
  screen.getByRole("button", { name: /connect wallet/i }).click();
  await waitFor(() => expect(screen.getByText(/you were paid/i)).toBeInTheDocument());
}

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/claim/${token}`]}>
      <Routes>
        <Route path="/claim/:token" element={<ClaimPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ClaimPage (spec §1.2: no secrets in the link, never asks for a spend key)", () => {
  it("shows a broken-link message for a malformed token", () => {
    renderAt("not-a-real-token!!");
    expect(screen.getByText(/looks broken/i)).toBeInTheDocument();
  });

  it("never renders any input for a spend key, secret key, private key, or seed phrase", () => {
    const token = encodeClaimToken({ indexerUrl: "http://x", incomingAddressHint: "hint", fromLeaf: 0, toLeaf: 10 });
    renderAt(token);
    const inputs = document.querySelectorAll("input");
    for (const input of Array.from(inputs)) {
      expect(input.getAttribute("type")).not.toBe("password");
    }
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/seed phrase|mnemonic/);
  });

  it("connecting derives the account from the wallet's signature and scans only the token's leaf range", async () => {
    const token = encodeClaimToken({ indexerUrl: "http://indexer.example", incomingAddressHint: "hint", fromLeaf: 5, toLeaf: 8 });
    const account = await SolanaAccount.fromSeed("claim-test-seed");
    vi.spyOn(walletLib, "connectPreferredWallet").mockResolvedValue({
      publicKey: PublicKey.default,
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    });
    vi.spyOn(walletLib, "deriveAccount").mockResolvedValue(account);
    const scanSpy = vi.spyOn(scanLib, "scanSingleKey").mockResolvedValue({
      notes: [
        { leafIndex: 6, note: { value: 500n, assetId: { toBigInt: () => 1n } }, nullifier: { toString: () => "0xabc" }, isIncoming: true },
        { leafIndex: 100, note: { value: 999n, assetId: { toBigInt: () => 1n } }, nullifier: { toString: () => "0xdef" }, isIncoming: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      balances: [],
    });

    renderAt(token);
    screen.getByRole("button", { name: /connect wallet/i }).click();

    await waitFor(() => expect(screen.getByText(/you were paid/i)).toBeInTheDocument());
    expect(screen.getByText(/500/)).toBeInTheDocument(); // only the in-range note counted, not the 999 one
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(scanSpy.mock.calls[0]?.[0]).toBe("http://indexer.example");
    expect(typeof scanSpy.mock.calls[0]?.[1]).toBe("string");
  });

  const WITHDRAWABLE = {
    indexerUrl: "http://indexer.example",
    incomingAddressHint: "hint",
    fromLeaf: 0,
    toLeaf: 10,
    programId: PublicKey.default.toBase58(),
    mint: PublicKey.default.toBase58(),
  };

  /** Stubs the chain-facing flow (`claimFlows.ts`) and lets the test drive the prover port the page
   *  hands it, so the page's own progress rendering is what's under test. */
  function stubWithdrawFlow(prove: (port: import("@kakure/sdk/tx").ProverPort) => Promise<void>) {
    vi.spyOn(claimFlows, "findClaimableNotes").mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notes: [{ leafIndex: 6, note: { value: 500n } } as any],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keyRepo: {} as any,
    });
    vi.spyOn(claimFlows, "withdrawClaimedNote").mockImplementation(async (opts) => {
      opts.onStage?.("assembling");
      opts.onStage?.("proving");
      await prove(opts.proverPort);
      opts.onStage?.("submitting");
      return { signature: "sig123", amount: 500n };
    });
  }

  it("withdraw drives the wasm prover through loading-pk / witness / proving, then submits and shows the payout", async () => {
    const token = encodeClaimToken(WITHDRAWABLE);
    const seenStages: string[] = [];
    const seenStatus: string[] = [];
    vi.spyOn(proverRouter, "proverFor").mockImplementation((_circuit, opts) => ({
      async capabilities() {
        return { circuits: [], environment: "wasm" as const };
      },
      async prove() {
        for (const stage of ["loading-pk", "witness", "proving"] as const) {
          opts.onWasmProgress?.({ circuit: 2, stage });
          seenStages.push(stage);
          // Each stage must be visible on screen while it is the current one.
          await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
          seenStatus.push(screen.getByRole("status").textContent ?? "");
        }
        return { circuitId: 2, proof: new Uint8Array(), publicInputs: [] };
      },
    }));
    stubWithdrawFlow((port) => port.prove(2, {}).then(() => undefined));

    await connectAndFindPayment(token);
    screen.getByRole("button", { name: /withdraw to my wallet/i }).click();

    await waitFor(() => expect(screen.getByText(/is in your wallet/i)).toBeInTheDocument());
    expect(seenStages).toEqual(["loading-pk", "witness", "proving"]);
    expect(seenStatus).toEqual([
      "Loading your device's proving key…",
      "Preparing your private payment…",
      "Generating privacy proof… ~1–2 min",
    ]);
    expect(screen.getByText(/sig123/)).toBeInTheDocument();
  });

  it("shows the current progress stage while still proving", async () => {
    const token = encodeClaimToken(WITHDRAWABLE);
    let resolveProve: (() => void) | undefined;
    vi.spyOn(proverRouter, "proverFor").mockImplementation((_circuit, opts) => ({
      async capabilities() {
        return { circuits: [], environment: "wasm" as const };
      },
      prove() {
        opts.onWasmProgress?.({ circuit: 2, stage: "witness" });
        return new Promise((resolve) => {
          resolveProve = () => resolve({ circuitId: 2, proof: new Uint8Array(), publicInputs: [] });
        });
      },
    }));
    stubWithdrawFlow((port) => port.prove(2, {}).then(() => undefined));

    await connectAndFindPayment(token);
    screen.getByRole("button", { name: /withdraw to my wallet/i }).click();

    await waitFor(() => expect(screen.getByText(/preparing your private payment/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /withdraw to my wallet/i })).not.toBeInTheDocument();
    resolveProve?.();
    await waitFor(() => expect(screen.getByText(/is in your wallet/i)).toBeInTheDocument());
  });

  it("a link without the pool program/mint can show the payment but not withdraw it", async () => {
    const token = encodeClaimToken({ indexerUrl: "http://indexer.example", incomingAddressHint: "hint", fromLeaf: 0, toLeaf: 10 });
    const withdrawSpy = vi.spyOn(claimFlows, "withdrawClaimedNote");
    await connectAndFindPayment(token);
    screen.getByRole("button", { name: /withdraw to my wallet/i }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn't available from this link/i));
    expect(withdrawSpy).not.toHaveBeenCalled();
  });

  it("shows a friendly not-found message when the scan finds nothing in range", async () => {
    const token = encodeClaimToken({ indexerUrl: "http://indexer.example", incomingAddressHint: "hint", fromLeaf: 0, toLeaf: 1 });
    const account = await SolanaAccount.fromSeed("claim-test-seed-2");
    vi.spyOn(walletLib, "connectPreferredWallet").mockResolvedValue({
      publicKey: PublicKey.default,
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    });
    vi.spyOn(walletLib, "deriveAccount").mockResolvedValue(account);
    vi.spyOn(scanLib, "scanSingleKey").mockResolvedValue({ notes: [], balances: [] });

    renderAt(token);
    screen.getByRole("button", { name: /connect wallet/i }).click();
    await waitFor(() => expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument());
  });
});
