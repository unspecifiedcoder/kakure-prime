import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { CircuitId } from "@kakure/sdk/tx";
import { decodeClaimToken } from "../lib/claimToken.js";
import { scanSingleKey, type SingleKeyScanResult } from "../lib/singleKeyScan.js";
import { connectPhantom, deriveAccount, type ConnectedWallet } from "../lib/wallet.js";
import { findClaimableNotes, withdrawClaimedNote } from "../lib/claimFlows.js";
import { browserEphemeralCounterStore } from "../lib/ephemeralCounters.js";
import { prewarmBrowserProver, proverFor } from "../prover/router.js";
import { useAppStore } from "../store/appStore.js";
import type { SolanaAccount } from "@kakure/sdk";
import { myReceiveAddress, encodeReceiveAddress } from "../lib/receiveAddress.js";
import { Steps } from "../ui/Steps.js";
import { PrivacySplit } from "../ui/PrivacySplit.js";
import { CopyLine } from "../ui/CopyButton.js";
import { PROVING_ETA, formatAmount, shortAddress } from "../ui/format.js";

const WITHDRAW_PROVING_HINT = "Generating privacy proof… ~1–2 min";

const WASM_STAGE_COPY: Record<"loading-pk" | "witness" | "proving", string> = {
  "loading-pk": "Loading your device's proving key…",
  witness: "Preparing your private payment…",
  proving: WITHDRAW_PROVING_HINT,
};

const WITHDRAW_STEPS = [
  { id: "assembling", label: "Preparing your withdrawal" },
  { id: "loading-pk", label: WASM_STAGE_COPY["loading-pk"], eta: PROVING_ETA["loading-pk"] },
  { id: "witness", label: WASM_STAGE_COPY.witness, eta: PROVING_ETA.witness },
  { id: "proving", label: WASM_STAGE_COPY.proving, eta: PROVING_ETA.proving },
  { id: "submitting", label: "Sending to your wallet" },
] as const;

type Status =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "scanning" }
  | { kind: "found"; result: SingleKeyScanResult }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

type WithdrawStatus =
  | { kind: "idle" }
  | { kind: "assembling" }
  | { kind: "proving"; stage: "loading-pk" | "witness" | "proving" }
  | { kind: "submitting" }
  | { kind: "done"; signature: string; amount: bigint }
  | { kind: "error"; message: string }
  | { kind: "unavailable" };

/**
 * Spec §1.2 Recipient claim page. The link carries no secrets (`claimToken.ts`); everything that
 * matters — decrypting and spending the note — happens after the recipient connects their own
 * wallet. Zero-install for the amounts-check (indexer scan); withdrawing needs browser proving
 * (§3, currently `WasmProver`, a stub — see App.tsx's ProverPort wiring).
 *
 * Deliberately has NO field anywhere for a spend key, secret key, or seed phrase (tested in
 * ClaimPage.test.tsx): the only key material this page ever touches is derived in-memory from the
 * connected wallet's own signature.
 */
export function ClaimPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const { settings } = useAppStore();
  /** Fresh pools have no compliance epochs in the indexer until the first rotation; the Pool
   *  account is authoritative for the current key, so fall back to it when the link names the pool. */
  function complianceFallback(c: { programId?: string; rpcUrl?: string }): { rpcUrl: string; programId: string } | undefined {
    return c.programId ? { rpcUrl: c.rpcUrl ?? settings.rpcUrl, programId: c.programId } : undefined;
  }
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [withdraw, setWithdraw] = useState<WithdrawStatus>({ kind: "idle" });
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [account, setAccount] = useState<SolanaAccount | null>(null);
  const [payAddress, setPayAddress] = useState<string | null>(null);

  /** The growth loop: a recipient who liked being paid privately gets their own pay address in
   *  one click -- derived from the account already in memory, nothing new to sign. */
  async function onGetPayAddress(): Promise<void> {
    if (!account) return;
    setPayAddress(encodeReceiveAddress(await myReceiveAddress(account, 0n)));
  }

  const claim = useMemo(() => {
    if (!token) return null;
    try {
      return decodeClaimToken(token);
    } catch {
      return null;
    }
  }, [token]);

  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [token]);

  useEffect(() => {
    if (!claim) return;
    void prewarmBrowserProver(CircuitId.Withdraw).catch(() => undefined);
  }, [claim]);

  async function connectAndScan(): Promise<void> {
    if (!claim) return;
    setStatus({ kind: "connecting" });
    try {
      const w = await connectPhantom();
      setWallet(w);
      const acct = await deriveAccount(w);
      setAccount(acct);

      setStatus({ kind: "scanning" });
      const viewKeyHex = (await acct.getViewKey()).toString();
      const result = await scanSingleKey(claim.indexerUrl, viewKeyHex, undefined, complianceFallback(claim));
      const relevant = result.notes.filter((n) => n.leafIndex >= claim.fromLeaf && n.leafIndex < claim.toLeaf);
      if (relevant.length === 0) {
        setStatus({ kind: "not-found" });
        return;
      }
      setStatus({ kind: "found", result: { ...result, notes: relevant } });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * §3A: withdraw proves entirely client-side, never via the Kakure Helper (`proverFor` routes
   * `CircuitId.Withdraw` to `@kakure/prover-wasm`, lazily loaded in a Web Worker on this route
   * only -- see `prover/router.ts` and `prover/realWasmProver.ts`). The witness itself is
   * `claimFlows.ts`'s `assembleWithdrawInputs` (scenario step 6, proved against the real circuit
   * in `claimFlows.test.ts`); the note comes from a FULL-account scan (spend scalar included), not
   * the view-only scan used for the amount above. Withdrawing needs the claim link to name the
   * pool program and mint -- older links without them get "not available" rather than an error.
   */
  async function onWithdraw(): Promise<void> {
    if (!claim || !wallet || !account) return;
    if (!claim.programId || !claim.mint) {
      setWithdraw({ kind: "unavailable" });
      return;
    }
    setWithdraw({ kind: "assembling" });
    try {
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const connection = new Connection(claim.rpcUrl ?? settings.rpcUrl);
      const counters = browserEphemeralCounterStore(wallet.publicKey.toBase58());
      const { notes, keyRepo } = await findClaimableNotes(claim.indexerUrl, account, claim, counters, undefined, complianceFallback(claim));
      const note = notes[0];
      if (!note) {
        setWithdraw({ kind: "error", message: "This payment has already been withdrawn, or isn't visible yet — try again in a moment." });
        return;
      }
      const port = proverFor(CircuitId.Withdraw, {
        helper: { baseUrl: settings.helperUrl, token: settings.helperToken },
        onWasmProgress: (event) => setWithdraw({ kind: "proving", stage: event.stage }),
      });
      const result = await withdrawClaimedNote({
        connection,
        wallet,
        account,
        keyRepo,
        programId: new PublicKey(claim.programId),
        mint: new PublicKey(claim.mint),
        indexerUrl: claim.indexerUrl,
        note,
        proverPort: port,
        onStage: (stage) => {
          if (stage === "proving") setWithdraw({ kind: "proving", stage: "loading-pk" });
          else if (stage === "submitting") setWithdraw({ kind: "submitting" });
        },
      });
      setWithdraw({ kind: "done", ...result });
    } catch (err) {
      setWithdraw({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!claim) {
    return (
      <main>
        <div className="block">
          <h1>This link looks broken</h1>
          <p className="lede">Ask whoever sent it to send it again. Nothing has been lost — the payment is still waiting.</p>
        </div>
      </main>
    );
  }

  const decimals = claim.decimals;
  const symbol = claim.symbol;
  const totalReceived = status.kind === "found" ? status.result.notes.reduce((sum, n) => sum + n.note.value, 0n) : 0n;
  const stepId =
    withdraw.kind === "assembling" || withdraw.kind === "submitting"
      ? withdraw.kind
      : withdraw.kind === "proving"
        ? withdraw.stage
        : undefined;
  const busy = withdraw.kind === "assembling" || withdraw.kind === "proving" || withdraw.kind === "submitting";

  return (
    <main>
      <div className="block hero">
        <span className="badge private">Private payment</span>
        <h1>{claim.payerName ? `${claim.payerName} paid you` : "You have a private payment waiting"}</h1>
        <p className="lede">
          Connect the wallet you shared your pay address from to see how much, and to move it to that wallet whenever
          you like. Nobody watching the blockchain can see this amount.
        </p>
        {status.kind === "idle" && (
          <div className="actions">
            <button type="button" className="primary big" onClick={() => void connectAndScan()}>
              Connect wallet
            </button>
          </div>
        )}
        {(status.kind === "connecting" || status.kind === "scanning") && (
          <p role="status">{status.kind === "connecting" ? "Waiting for your wallet…" : "Checking… this takes a few seconds."}</p>
        )}
        {status.kind === "error" && <p role="alert">{status.message}</p>}
        {status.kind === "not-found" && (
          <div className="empty">
            Nothing here yet. Payments usually appear within a minute of being sent — try again in a moment, and check
            you connected the wallet you shared your pay address from.
          </div>
        )}
      </div>

      {status.kind === "found" && (
        <section className="block" aria-label="Payment found">
          <PrivacySplit
            amount={formatAmount(totalReceived, decimals, symbol)}
            caption={claim.payerName ? `You were paid privately by ${claim.payerName}.` : "You were paid privately."}
          />

          {(withdraw.kind === "idle" || withdraw.kind === "error" || withdraw.kind === "unavailable") && (
            <div className="actions row">
              <button type="button" className="primary big" onClick={() => void onWithdraw()}>
                Withdraw to my wallet
              </button>
              <button type="button" className="big" onClick={() => setWithdraw({ kind: "idle" })}>
                Keep it private
              </button>
            </div>
          )}
          <p className="hint" style={{ marginTop: "0.75rem" }}>
            Withdrawing moves the tokens into your normal wallet balance, where they become public like any other
            balance. Keeping it private leaves it in the pool: it stays yours, hidden, and you can withdraw later.
          </p>

          {busy && (
            <>
              <p role="status">{stepId ? WITHDRAW_STEPS.find((s) => s.id === stepId)?.label : ""}</p>
              <Steps steps={WITHDRAW_STEPS} current={stepId} />
              <p className="hint">Keep this tab open. The proof is generated on this device — nothing about your payment leaves it.</p>
            </>
          )}

          {withdraw.kind === "done" && (
            <div className="receipt" role="status">
              <h2>Done — {formatAmount(withdraw.amount, decimals, symbol)} is in your wallet.</h2>
              <dl>
                <dt>Amount</dt>
                <dd>{formatAmount(withdraw.amount, decimals, symbol)}</dd>
                <dt>To wallet</dt>
                <dd className="mono">{wallet ? shortAddress(wallet.publicKey.toBase58()) : ""}</dd>
                <dt>Transaction</dt>
                <dd className="mono">{withdraw.signature}</dd>
              </dl>
            </div>
          )}
          {withdraw.kind === "unavailable" && (
            <p role="alert">Withdrawing isn&apos;t available from this link — ask whoever paid you for a newer one. The payment is still yours.</p>
          )}
          {withdraw.kind === "error" && <p role="alert">{withdraw.message}</p>}

          <div className="block">
            <h2>Want to get paid this way by others?</h2>
            <p>
              Your pay address works like a bank account number: share it with anyone, and what they pay you stays
              private. It is derived from your wallet; there is nothing new to set up.
            </p>
            {payAddress ? (
              <CopyLine value={payAddress} label="pay address" />
            ) : (
              <button type="button" onClick={() => void onGetPayAddress()}>
                Get my private pay address
              </button>
            )}
          </div>

          <details>
            <summary>Details</summary>
            <p>{status.result.notes.length} payment(s) found between leaf {claim.fromLeaf} and {claim.toLeaf}.</p>
            <p>Wallet: {wallet?.publicKey.toBase58()}</p>
          </details>
        </section>
      )}
    </main>
  );
}
