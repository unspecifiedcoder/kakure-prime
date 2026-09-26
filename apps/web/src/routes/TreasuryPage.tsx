import { useState } from "react";
import { useParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useAppStore } from "../store/appStore.js";
import { loadEncrypted } from "../lib/keystore.js";
import type { GroupRecord } from "../lib/treasury.js";
import { parsePayrollCsv, totalAmount, type PayrollRow } from "../lib/payrollPlan.js";
import { scanMultisigGroup, scanMultisigGroupViews } from "../lib/multisigScan.js";
import { prewarmBrowserProver, proverFor } from "../prover/router.js";
import { CircuitId } from "@kakure/sdk/tx";
import { assetId } from "@kakure/sdk/solana";
import { depositToTreasury, payOneRecipient, ensureLookupTable, selectSpendableNotes } from "../lib/treasuryFlows.js";
import { InMemoryEphemeralCounterStore } from "@kakure/sdk";
import { encodeClaimToken } from "../lib/claimToken.js";
import { decodeReceiveAddress } from "../lib/receiveAddress.js";
import { connectPhantom } from "../lib/wallet.js";
import { CopyLine } from "../ui/CopyButton.js";
import { Steps } from "../ui/Steps.js";
import { formatAmount, parseAmount, shortAddress, PROVING_ETA } from "../ui/format.js";
import { KNOWN_TOKENS, resolveToken, type TokenInfo } from "../ui/tokens.js";
import { humanizeError } from "../ui/errors.js";

const PAY_STEPS = [
  { id: "proving", label: "Preparing the private payment" },
  { id: "awaiting-signatures", label: "Collecting approvals from signers" },
  { id: "proving-2", label: "Generating the privacy proof", eta: PROVING_ETA.proving },
  { id: "confirmed", label: "Sent — claim link ready" },
];

function rowStatusLabel(status: PayrollRow["status"]): string {
  switch (status) {
    case "pending": return "Pending";
    case "proving": return "Preparing";
    case "awaiting-signatures": return "Awaiting approvals";
    case "confirmed": return "Sent";
    case "failed": return "Failed";
    default: return String(status);
  }
}

type Tab = "fund" | "pay" | "balances" | "settings";

function mintForNote(mintInput: string, note: { note: { assetId: { toBigInt(): bigint } } }): string | undefined {
  if (!mintInput) return undefined;
  try {
    const mint = new PublicKey(mintInput);
    let v = 0n;
    for (const b of assetId(mint)) v = (v << 8n) | BigInt(b);
    return v === note.note.assetId.toBigInt() ? mint.toBase58() : undefined;
  } catch {
    return undefined;
  }
}
type UnlockStatus = { kind: "locked" } | { kind: "unlocked"; group: GroupRecord } | { kind: "error"; message: string };

const PROVING_HINT = "Generating privacy proof… ~30–120 s";

export function TreasuryPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { settings, updateSettings } = useAppStore();
  const [tab, setTab] = useState<Tab>("fund");
  const [passphrase, setPassphrase] = useState("");
  const [unlock, setUnlock] = useState<UnlockStatus>({ kind: "locked" });

  const [fundMint, setFundMint] = useState(KNOWN_TOKENS[0]!.mint);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [fundAmount, setFundAmount] = useState("");
  const [fundStatus, setFundStatus] = useState<{ kind: "idle" | "proving" | "submitting" | "done"; error?: string }>({
    kind: "idle",
  });

  const [csvText, setCsvText] = useState("");
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const [balances, setBalances] = useState<readonly { assetId: string; total: bigint }[] | null>(null);

  async function onUnlock(): Promise<void> {
    if (!id) return;
    try {
      const group = await loadEncrypted<GroupRecord>(id, passphrase);
      setUnlock({ kind: "unlocked", group });
      void prewarmBrowserProver(CircuitId.Deposit).catch(() => undefined);
    } catch (err) {
      setUnlock({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function onParseCsv(): void {
    setParseError(null);
    try {
      setRows(parsePayrollCsv(csvText, token ? { decimals: token.decimals } : {}));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  }

  function requireProgramId(): PublicKey {
    if (!settings.programId) throw new Error("Set the pool program id in Settings before using this treasury.");
    return new PublicKey(settings.programId);
  }

  async function onResolveToken(): Promise<TokenInfo | null> {
    setTokenError(null);
    try {
      const connection = new (await import("@solana/web3.js")).Connection(settings.rpcUrl);
      const t = await resolveToken(connection, fundMint.trim());
      setToken(t);
      return t;
    } catch (err) {
      setTokenError(humanizeError(err).message);
      return null;
    }
  }

  async function onFund(): Promise<void> {
    if (unlock.kind !== "unlocked") return;
    setFundStatus({ kind: "proving" });
    try {
      const t = token ?? (await onResolveToken());
      if (!t) throw new Error("Pick a token first.");
      const programId = requireProgramId();
      const wallet = await connectPhantom();
      const connection = new (await import("@solana/web3.js")).Connection(settings.rpcUrl);
      const proverPort = proverFor(CircuitId.Deposit, { helper: { baseUrl: settings.helperUrl, token: settings.helperToken } });
      const alt = await ensureLookupTable(connection, wallet);
      setFundStatus({ kind: "submitting" });
      await depositToTreasury({
        connection,
        wallet,
        programId,
        mint: new PublicKey(t.mint),
        amount: parseAmount(fundAmount, t.decimals),
        gpk: [BigInt("0x" + unlock.group.gpk.x), BigInt("0x" + unlock.group.gpk.y)],
        groupViewSecret: BigInt(unlock.group.groupViewKey.v),
        depositorMemberId: BigInt(unlock.group.myId),
        proverPort,
        alt,
      });
      setFundStatus({ kind: "done" });
    } catch (err) {
      setFundStatus({ kind: "idle", error: humanizeError(err).message });
    }
  }

  async function onPay(): Promise<void> {
    if (unlock.kind !== "unlocked" || rows.length === 0) return;
    setPaying(true);
    const group = unlock.group;
    try {
      const wallet = await connectPhantom();
      const { Connection } = await import("@solana/web3.js");
      const connection = new Connection(settings.rpcUrl);
      const proverPort = proverFor(CircuitId.TransferMultisig, { helper: { baseUrl: settings.helperUrl, token: settings.helperToken } });
      const programId = requireProgramId();
      const alt = await ensureLookupTable(connection, wallet);

      // Note selection (spec §2: sdk tx/plan.ts picks/chains notes) is out of scope for this pass
      // -- the group's oldest UNSPENT multisig note is the chain's starting point (the scanner
      // reports spent notes too; `selectSpendableNotes` checks the pool's nullifier PDAs); a real
      // deployment with many notes would run planSpend() first. The view must be the scanner's
      // real `MultisigNoteView` -- see `treasuryFlows.assertRealNoteView`.
      const views = await scanMultisigGroupViews(settings.indexerUrl, {
        v: group.groupViewKey.v,
        gpkX: group.gpk.x,
        gpkY: group.gpk.y,
        memberIds: group.participantIds,
      });
      const spendable = await selectSpendableNotes(connection, programId, views);
      let sourceNote = spendable[0];
      if (!sourceNote) throw new Error("no spendable treasury note found — fund the treasury first");
      // One counter store for the whole batch so change ephemerals never repeat across rows.
      const ephemeralCounters = new InMemoryEphemeralCounterStore();
      // A note only carries the asset id (a one-way hash of the mint); the claim link needs the
      // mint itself for the recipient to withdraw. The Fund tab's mint is it when it hashes to
      // this note's asset -- otherwise the link is view-only (see ClaimPage's "unavailable").
      const claimMint = mintForNote(fundMint, sourceNote);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "proving" } : r)));
        try {
          const recipient = decodeReceiveAddress(row.address);
          const proposalId = `${id}-row-${i}`;
          setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "awaiting-signatures" } : r)));
          const result = await payOneRecipient({
            connection,
            wallet,
            programId,
            coordinatorUrl: settings.coordinatorUrl,
            indexerUrl: settings.indexerUrl,
            sessionId: group.sessionId,
            proposalId,
            group,
            proverPort,
            alt,
            sourceNote,
            recipient,
            amount: row.amount,
            quorum: [{ myId: BigInt(group.myId), secretShare: BigInt(group.mySecretShare) }],
            ephemeralCounters,
          });
          const claimLink = encodeClaimToken({
            indexerUrl: settings.indexerUrl,
            incomingAddressHint: row.address.slice(0, 12),
            fromLeaf: 0,
            toLeaf: 1_000_000,
            programId: programId.toBase58(),
            rpcUrl: settings.rpcUrl,
            payerName: group.name,
            ...(claimMint ? { mint: claimMint } : {}),
            ...(token ? { decimals: token.decimals, symbol: token.symbol } : {}),
          });
          setRows((prev) =>
            prev.map((r, idx) => (idx === i ? { ...r, status: "confirmed", claimLink } : r)),
          );
          sourceNote = result.changeNote;
        } catch (err) {
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i ? { ...r, status: "failed", error: humanizeError(err).message } : r,
            ),
          );
          break;
        }
      }
    } finally {
      setPaying(false);
    }
  }

  async function onLoadBalances(): Promise<void> {
    if (unlock.kind !== "unlocked") return;
    const group = unlock.group;
    const result = await scanMultisigGroup(settings.indexerUrl, {
      v: group.groupViewKey.v,
      gpkX: group.gpk.x,
      gpkY: group.gpk.y,
      memberIds: group.participantIds,
    });
    setBalances(result.balances);
  }

  if (unlock.kind !== "unlocked") {
    return (
      <main>
        <div className="block">
          <h1>Unlock treasury</h1>
          <p className="lede">Your share of this treasury is encrypted on this device. Enter the passphrase you chose when you joined.</p>
          <div className="field">
            <label htmlFor="unlock-passphrase">Passphrase</label>
            <input id="unlock-passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void onUnlock()} />
          </div>
          <button type="button" className="primary" onClick={() => void onUnlock()}>
            Unlock
          </button>
          {unlock.kind === "error" && <p role="alert">{humanizeError(unlock.message).message}</p>}
        </div>
      </main>
    );
  }

  const group = unlock.group;
  const sent = rows.filter((r) => r.status === "confirmed").length;
  const activeRow = rows.find((r) => r.status === "proving" || r.status === "awaiting-signatures");

  return (
    <main>
      <div className="block">
        <div className="block-head">
          <h1>{group.name}</h1>
          <span className="badge">Any {group.threshold} of {group.participantIds.length} signers approve</span>
        </div>
        {!settings.programId && (
          <p className="badge warn" role="note">Not pointed at a pool yet — set the pool program id under Settings.</p>
        )}
      </div>
      <div role="tablist">
        <button type="button" role="tab" aria-selected={tab === "fund"} onClick={() => setTab("fund")}>Fund</button>
        <button type="button" role="tab" aria-selected={tab === "pay"} onClick={() => setTab("pay")}>Pay people</button>
        <button type="button" role="tab" aria-selected={tab === "balances"} onClick={() => setTab("balances")}>Balances</button>
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>Settings</button>
      </div>

      {(tab === "fund" || tab === "pay") && (
        <section className="block" aria-label="Token">
          <div className="row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="fund-mint">Token</label>
              <input id="fund-mint" list="known-tokens" value={fundMint} onChange={(e) => { setFundMint(e.target.value); setToken(null); }} />
              <datalist id="known-tokens">
                {KNOWN_TOKENS.map((t) => (
                  <option key={t.mint} value={t.mint}>{t.symbol}</option>
                ))}
              </datalist>
            </div>
            <button type="button" onClick={() => void onResolveToken()}>Use this token</button>
            {token && <span className="badge ok">{token.symbol}, {token.decimals} decimals</span>}
          </div>
          {tokenError && <p role="alert">{tokenError}</p>}
          {!token && <p className="hint">Pick USDC from the list or paste a mint address, then choose it. Amounts below are in that token.</p>}
        </section>
      )}

      {tab === "fund" && (
        <section className="block" aria-label="Fund">
          <h2>Fund the treasury</h2>
          <p>Moves tokens from your connected wallet into the treasury&apos;s private balance. From then on, only a quorum of signers can move them.</p>
          <div className="field">
            <label htmlFor="fund-amount">Amount{token ? ` (${token.symbol})` : ""}</label>
            <input id="fund-amount" inputMode="decimal" placeholder={token ? "1,000.00" : ""} value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} />
          </div>
          <button type="button" className="primary" onClick={() => void onFund()} disabled={fundStatus.kind !== "idle" && fundStatus.kind !== "done"}>
            Fund treasury
          </button>
          {fundStatus.kind === "proving" && (
            <>
              <p role="status">{PROVING_HINT}</p>
              <Steps steps={[{ id: "prove", label: "Generating the privacy proof", eta: PROVING_ETA.proving }, { id: "send", label: "Sending from your wallet" }]} current="prove" />
            </>
          )}
          {fundStatus.kind === "submitting" && <p role="status">Sending from your wallet…</p>}
          {fundStatus.kind === "done" && <div className="notice">Funded. The balance will show under Balances once the network confirms it.</div>}
          {fundStatus.error && <p role="alert">{fundStatus.error}</p>}
        </section>
      )}

      {tab === "pay" && (
        <section className="block" aria-label="Pay people">
          <h2>Pay people</h2>
          <p>One line per person: their private pay address, the amount{token ? ` in ${token.symbol}` : ""}, and an optional memo only they will see. Every payment gets a claim link to send them.</p>
          <div className="field" style={{ maxWidth: "48rem" }}>
            <label htmlFor="payroll-csv">Recipients (one per line: address,amount,memo)</label>
            <textarea id="payroll-csv" placeholder={"kakure1…,1500,September\nkakure1…,900,September"} value={csvText} onChange={(e) => setCsvText(e.target.value)} />
          </div>
          <button type="button" onClick={onParseCsv}>Preview</button>
          {parseError && <p role="alert">{parseError}</p>}
          {rows.length > 0 && (
            <>
              <div className="table-wrap" style={{ marginTop: "1rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Recipient</th>
                      <th className="num">Amount</th>
                      <th>Memo</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="mono" title={r.address}>{shortAddress(r.address, 8, 4)}</td>
                        <td className="num">{formatAmount(r.amount, token?.decimals, token?.symbol)}</td>
                        <td>{r.memo}</td>
                        <td>
                          <span className={`badge ${r.status === "confirmed" ? "private" : r.status === "failed" ? "danger" : ""}`}>{rowStatusLabel(r.status)}</span>
                          {r.claimLink && (
                            <div style={{ marginTop: "0.375rem" }}>
                              <CopyLine value={`${window.location.origin}${window.location.pathname}#/claim/${r.claimLink}`} label="claim link" />
                            </div>
                          )}
                          {r.error && <span role="alert">{r.error}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ justifyContent: "space-between", marginTop: "1rem" }}>
                <p style={{ margin: 0 }}>
                  Total: {formatAmount(totalAmount(rows), token?.decimals, token?.symbol)} to {rows.length} {rows.length === 1 ? "person" : "people"}
                  {sent > 0 ? ` — ${sent} sent` : ""}
                </p>
                <button type="button" className="primary" onClick={() => void onPay()} disabled={paying}>
                  {paying ? "Paying…" : "Pay everyone"}
                </button>
              </div>
              {activeRow && (
                <>
                  <p role="status">Paying {shortAddress(activeRow.address, 8, 4)} — each payment needs {group.threshold} approvals and its own proof.</p>
                  <Steps steps={PAY_STEPS} current={activeRow.status === "awaiting-signatures" ? "awaiting-signatures" : "proving"} />
                </>
              )}
            </>
          )}
        </section>
      )}

      {tab === "balances" && (
        <section className="block" aria-label="Balances">
          <div className="block-head">
            <h2>Balances</h2>
            <button type="button" onClick={() => void onLoadBalances()}>Refresh balances</button>
          </div>
          <p>Read with the treasury&apos;s view key. Only signers and whoever you give an accountant key to can see these.</p>
          {balances && balances.length === 0 && <div className="empty">Nothing in this treasury yet. Fund it to get started.</div>}
          {balances && balances.length > 0 && (
            <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
              {balances.map((b) => (
                <li key={b.assetId} className="row" style={{ justifyContent: "space-between", maxWidth: "36rem" }}>
                  <span className="mono" title={b.assetId}>{token && mintForNote(token.mint, { note: { assetId: { toBigInt: () => BigInt(b.assetId) } } }) ? token.symbol : shortAddress(b.assetId, 8, 6)}</span>
                  <strong>{token && mintForNote(token.mint, { note: { assetId: { toBigInt: () => BigInt(b.assetId) } } }) ? formatAmount(b.total, token.decimals) : b.total.toString()}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "settings" && (
        <section className="block" aria-label="Settings">
          <h2>Settings</h2>
          <div className="grid-2">
            <div>
              <h3>This treasury</h3>
              <p>Signers: {group.participantIds.length} — any {group.threshold} approve a payment.</p>
              <p className="mono" style={{ fontSize: "0.8125rem" }}>Treasury id: {group.sessionId}</p>
            </div>
            <div>
              <h3>Network</h3>
              <div className="field">
                <label htmlFor="settings-program-id">Pool program id</label>
                <input id="settings-program-id" value={settings.programId} onChange={(e) => updateSettings({ programId: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="settings-rpc-url">Solana RPC URL</label>
                <input id="settings-rpc-url" value={settings.rpcUrl} onChange={(e) => updateSettings({ rpcUrl: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="settings-indexer-url">Indexer URL</label>
                <input id="settings-indexer-url" value={settings.indexerUrl} onChange={(e) => updateSettings({ indexerUrl: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="settings-coordinator-url">Coordinator URL</label>
                <input id="settings-coordinator-url" value={settings.coordinatorUrl} onChange={(e) => updateSettings({ coordinatorUrl: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="settings-helper-url">Kakure Helper URL</label>
                <input id="settings-helper-url" value={settings.helperUrl} onChange={(e) => updateSettings({ helperUrl: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="settings-helper-token">Kakure Helper token</label>
                <input id="settings-helper-token" type="password" autoComplete="off" value={settings.helperToken} onChange={(e) => updateSettings({ helperToken: e.target.value })} />
                <p className="hint">Printed by the helper when it starts. Kept in memory only.</p>
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
