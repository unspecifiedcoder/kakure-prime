import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppStore } from "../store/appStore.js";
import { connectPhantom, deriveAccount } from "../lib/wallet.js";
import { createOrJoinTreasury, decodeInvite, encodeInvite } from "../lib/treasury.js";
import { CopyLine } from "../ui/CopyButton.js";
import { Steps } from "../ui/Steps.js";
import { shortAddress } from "../ui/format.js";
import { MarketStrip } from "../ui/MarketStrip.js";

const CEREMONY_STEPS = [
  { id: "waiting", label: "Waiting for every signer to open the invite" },
  { id: "keys", label: "Signers generate the treasury key together — no one ever holds it alone", eta: "about a minute" },
  { id: "save", label: "Saving your share, encrypted with your passphrase" },
];

type ConnectStatus = { kind: "idle" } | { kind: "connecting" } | { kind: "error"; message: string };
type CeremonyStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string }
  | { kind: "done"; sessionId: string; invite?: string };

/**
 * Spec §1.1: connect → create/join a private treasury. A DAO ops person with no crypto background
 * should be able to read this page; jargon ("DKG ceremony", "FROST session") stays in a collapsible
 * "Details" rather than the main copy.
 */
export function Home(): JSX.Element {
  const navigate = useNavigate();
  const { walletPublicKey, connect, treasuries, addTreasury, settings } = useAppStore();

  const [connectStatus, setConnectStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState(3);
  const [memberCount, setMemberCount] = useState(5);
  const [passphrase, setPassphrase] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [ceremony, setCeremony] = useState<CeremonyStatus>({ kind: "idle" });

  async function onConnect(): Promise<void> {
    setConnectStatus({ kind: "connecting" });
    try {
      const wallet = await connectPhantom();
      const account = await deriveAccount(wallet);
      connect(wallet.publicKey, account);
      setConnectStatus({ kind: "idle" });
    } catch (err) {
      setConnectStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onCreate(): Promise<void> {
    setCeremony({ kind: "running" });
    try {
      const record = await createOrJoinTreasury({
        coordinatorUrl: settings.coordinatorUrl,
        name,
        threshold,
        memberCount,
        passphrase,
      });
      addTreasury({ id: record.sessionId, name: record.name, threshold: record.threshold, signerCount: record.memberCount });
      const invite = encodeInvite({
        coordinatorUrl: settings.coordinatorUrl,
        sessionId: record.sessionId,
        name: record.name,
        threshold: record.threshold,
        memberCount: record.memberCount,
      });
      setCeremony({ kind: "done", sessionId: record.sessionId, invite });
    } catch (err) {
      setCeremony({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onJoin(): Promise<void> {
    setCeremony({ kind: "running" });
    try {
      const invite = decodeInvite(inviteToken.trim());
      const record = await createOrJoinTreasury({
        coordinatorUrl: invite.coordinatorUrl,
        name: invite.name,
        threshold: invite.threshold,
        memberCount: invite.memberCount,
        sessionId: invite.sessionId,
        passphrase,
      });
      addTreasury({ id: record.sessionId, name: record.name, threshold: record.threshold, signerCount: record.memberCount });
      setCeremony({ kind: "done", sessionId: record.sessionId });
    } catch (err) {
      setCeremony({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const connected = walletPublicKey !== null;

  return (
    <main>
      <div className="block hero">
        <div className="eyebrow">PRIVATE MARKETS · POWERED BY ZERO KNOWLEDGE</div>
        <h1>Your equity strategy should not be public alpha.</h1>
        <p className="lede">
          Kakure Prime gives funds, DAOs, and global teams a confidential vault for tokenized stocks. Positions, recipients,
          and signer structure stay shielded while every movement remains provable and selectively auditable.
        </p>
        <div className="proof-row" aria-label="Product capabilities">
          <span><b>01</b> Token-2022 equities</span>
          <span><b>02</b> Threshold approval</span>
          <span><b>03</b> Private settlement</span>
          <span><b>04</b> Committee audit</span>
        </div>
        <section aria-label="Demo, videos, and wallet" className="actions">
          <Link className="btn primary big demo-cta" to="/demo">
            Launch 60-second judge demo
          </Link>
          <a className="btn big" href="/pitch-video.html">
            Watch pitch video
          </a>
          <a className="btn big" href="/demo-video.html">
            Technical walkthrough
          </a>
          {connected ? (
            <p>
              Connected: <span className="chip">{shortAddress(walletPublicKey!.toBase58())}</span>
            </p>
          ) : (
            <button type="button" className="primary big" onClick={() => void onConnect()} disabled={connectStatus.kind === "connecting"}>
              {connectStatus.kind === "connecting" ? "Waiting for your wallet…" : "Enter private markets"}
            </button>
          )}
          {connectStatus.kind === "error" && <p role="alert">{connectStatus.message}</p>}
        </section>
      </div>

      <MarketStrip />

      <section className="block thesis" aria-label="Why private equities">
        <div>
          <div className="eyebrow">THE MISSING MARKET PRIMITIVE</div>
          <h2>On-chain equities settle instantly. Your strategy leaks forever.</h2>
        </div>
        <p>
          Public wallets reveal accumulation, treasury concentration, employee grants, and every rebalance before the market
          forgets. Kakure Prime turns any supported equity position into a shielded note controlled by a signer quorum—not a
          custodian—then lets recipients exit to their own wallet with a private claim link.
        </p>
      </section>

      <section className="privacy-demo" aria-label="Public chain versus Kakure Prime">
        <div className="chain-view">
          <span className="demo-label">WHAT THE CHAIN SEES</span>
          <code>0x18f7…91c2</code>
          <code>commitment_7d91…</code>
          <code>proof ✓</code>
          <span className="muted">No ticker · No amount · No recipient · No signer graph</span>
        </div>
        <div className="private-view">
          <span className="demo-label">WHAT YOUR QUORUM SEES</span>
          <div className="position-line"><span>AAPLx allocation</span><strong>42.50 shares</strong></div>
          <div className="position-line"><span>Approved by</span><strong>3 of 5</strong></div>
          <div className="position-line"><span>Settlement</span><strong>Private · final</strong></div>
          <span className="badge private">Auditor access available by quorum</span>
        </div>
      </section>

      <section className="block" aria-label="Your treasuries">
        <div className="block-head">
          <h2>Your treasuries</h2>
        </div>
        {treasuries.length === 0 ? (
          <div className="empty">
            No private portfolios yet. Create one below, or paste an invite if a colleague already set one up. Everything is stored
            encrypted in this browser.
          </div>
        ) : (
          <ul className="treasuries">
            {treasuries.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => navigate(`/treasury/${t.id}`)}>
                  <span className="name">{t.name}</span>
                  <span className="meta">
                    Any {t.threshold} of {t.signerCount} signers approve a payment
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid-2">
        <section className="block" aria-label="Create a private treasury">
          <h2>Create a private portfolio</h2>
          <p>Set the approval policy once. Signers create the custody key together; no single person ever possesses it.</p>
          <div className="field">
            <label htmlFor="treasury-name">Name</label>
            <input id="treasury-name" placeholder="e.g. Frontier Equity Fund" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="treasury-threshold">Approvals needed</label>
              <input id="treasury-threshold" type="number" min={1} max={memberCount} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="treasury-members">Total signers</label>
              <input id="treasury-members" type="number" min={1} max={7} value={memberCount} onChange={(e) => setMemberCount(Number(e.target.value))} />
            </div>
          </div>
          <p className="hint">
            Any {threshold} of {memberCount} signers will be able to approve a payment. Nobody can spend alone.
          </p>
          <div className="field">
            <label htmlFor="treasury-passphrase">Passphrase</label>
            <input id="treasury-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <p className="hint">Protects your share on this device. We cannot recover it — if you lose it, the other signers can still pay, but you cannot approve.</p>
          </div>
          <button type="button" className="primary" onClick={() => void onCreate()} disabled={ceremony.kind === "running"}>
            Create
          </button>
        </section>

        <section className="block" aria-label="Join a treasury">
          <h2>Join a private portfolio</h2>
          <p>Paste the invite a colleague sent you. You will take part in creating the key, then hold one share of it.</p>
          <div className="field">
            <label htmlFor="invite-token">Invite link or code</label>
            <input id="invite-token" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="join-passphrase">Passphrase</label>
            <input id="join-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <p className="hint">Protects your share on this device.</p>
          </div>
          <button type="button" onClick={() => void onJoin()} disabled={ceremony.kind === "running"}>
            Join
          </button>
        </section>
      </div>

      {ceremony.kind === "running" && (
        <section className="block" aria-label="Setting up">
          <p role="status">Setting up the treasury with the other signers… this can take a minute.</p>
          <Steps steps={CEREMONY_STEPS} current="keys" />
          <p className="hint">Keep this tab open until every signer has joined.</p>
        </section>
      )}
      {ceremony.kind === "error" && <p role="alert">{ceremony.message}</p>}
      {ceremony.kind === "done" && (
        <section className="block" aria-label="Treasury ready">
          <div className="notice">Treasury ready.</div>
          {ceremony.invite && (
            <div style={{ marginTop: "1rem" }}>
              <h3>Invite your co-signers</h3>
              <p>Each signer opens this in their own browser and picks their own passphrase. Send it over a channel you trust; it identifies the treasury but cannot spend from it.</p>
              <CopyLine value={ceremony.invite} label="invite" />
            </div>
          )}
          <div className="actions row" style={{ marginTop: "1rem" }}>
            <button type="button" className="primary" onClick={() => navigate(`/treasury/${ceremony.sessionId}`)}>
              Open treasury
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
