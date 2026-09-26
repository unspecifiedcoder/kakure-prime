import { useEffect, useMemo, useState } from "react";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useAppStore } from "../store/appStore.js";
import {
  clearActiveWallet,
  createKakureWallet,
  getActiveWallet,
  hasKakureWallet,
  KAKURE_WALLET_ID,
  unlockKakureWallet,
  deriveAccount,
} from "../lib/wallet.js";
import { exportEncryptedBlob } from "../lib/keystore.js";
import { CopyLine } from "../ui/CopyButton.js";

const DEVNET_RPC = "https://api.devnet.solana.com";
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEVNET_PROGRAM_ID = "HPzs68TncDWTHocTZv5ekvpMwDjcx4PeHLoTedwBsccF";

type WalletState = "loading" | "missing" | "locked" | "unlocked";
type Cluster = "devnet" | "mainnet-beta";

function clusterFor(rpcUrl: string): Cluster {
  return rpcUrl.toLowerCase().includes("devnet") ? "devnet" : "mainnet-beta";
}

export function WalletPage(): JSX.Element {
  const { walletPublicKey, connect, disconnect, settings, updateSettings } = useAppStore();
  const [state, setState] = useState<WalletState>(getActiveWallet() ? "unlocked" : "loading");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const cluster = useMemo(() => clusterFor(settings.rpcUrl), [settings.rpcUrl]);

  useEffect(() => {
    if (state !== "loading") return;
    void hasKakureWallet().then((exists) => setState(exists ? "locked" : "missing"));
  }, [state]);

  useEffect(() => {
    if (!walletPublicKey || state !== "unlocked") {
      setBalance(null);
      return;
    }
    const connection = new Connection(settings.rpcUrl, "confirmed");
    void connection.getBalance(walletPublicKey).then((lamports) => setBalance(lamports / LAMPORTS_PER_SOL)).catch(() => setBalance(null));
  }, [settings.rpcUrl, state, walletPublicKey]);

  async function activate(wallet: Awaited<ReturnType<typeof unlockKakureWallet>>): Promise<void> {
    const account = await deriveAccount(wallet);
    connect(wallet.publicKey, account);
    setPassphrase("");
    setConfirmPassphrase("");
    setState("unlocked");
    setMessage("Kakure Wallet unlocked. Keys remain inside this browser.");
  }

  async function createWallet(): Promise<void> {
    setError("");
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases do not match.");
      return;
    }
    try {
      await activate(await createKakureWallet(passphrase));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function unlock(): Promise<void> {
    setError("");
    try {
      await activate(await unlockKakureWallet(passphrase));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function lock(): void {
    clearActiveWallet();
    disconnect();
    setBalance(null);
    setState("locked");
    setMessage("Kakure Wallet locked.");
  }

  function changeCluster(next: Cluster): void {
    updateSettings(
      next === "devnet"
        ? { rpcUrl: DEVNET_RPC, programId: DEVNET_PROGRAM_ID }
        : { rpcUrl: MAINNET_RPC, programId: "" },
    );
    setMessage(next === "devnet" ? "Switched to Solana Devnet." : "Mainnet selected. Portfolio reads are enabled; Kakure settlement activates after audited programs are deployed.");
  }

  async function downloadBackup(): Promise<void> {
    const json = await exportEncryptedBlob(KAKURE_WALLET_ID);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kakure-wallet-${walletPublicKey?.toBase58().slice(0, 8) ?? "backup"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Encrypted wallet backup downloaded.");
  }

  const explorer = walletPublicKey
    ? `https://explorer.solana.com/address/${walletPublicKey.toBase58()}${cluster === "devnet" ? "?cluster=devnet" : ""}`
    : "";

  return (
    <main className="wallet-page">
      <section className="wallet-hero">
        <div>
          <div className="eyebrow">KAKURE WALLET · PRIVATE-MARKET CUSTODY</div>
          <h1>One wallet for public assets and shielded positions.</h1>
          <p className="lede">Local encrypted custody, Solana-native signing, and a direct path into Kakure&apos;s private settlement layer.</p>
        </div>
        <label className="network-switcher">
          <span>Network</span>
          <select aria-label="Wallet network" value={cluster} onChange={(event) => changeCluster(event.target.value as Cluster)}>
            <option value="devnet">Solana Devnet</option>
            <option value="mainnet-beta">Solana Mainnet</option>
          </select>
        </label>
      </section>

      {state === "loading" && <p role="status">Opening encrypted wallet vault…</p>}

      {state === "missing" && (
        <section className="wallet-card" aria-label="Create Kakure Wallet">
          <span className="wallet-card-kicker">CREATE WALLET</span>
          <h2>Encrypted from the first byte.</h2>
          <p>The signing key is generated locally and stored in an encrypted browser vault. Kakure services never receive it.</p>
          <div className="field">
            <label htmlFor="wallet-passphrase">Wallet passphrase</label>
            <input id="wallet-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
            <p className="hint">At least 12 characters. Kakure cannot recover this passphrase.</p>
          </div>
          <div className="field">
            <label htmlFor="wallet-passphrase-confirm">Confirm passphrase</label>
            <input id="wallet-passphrase-confirm" type="password" autoComplete="new-password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} />
          </div>
          <button className="primary" type="button" onClick={() => void createWallet()}>Create Kakure Wallet</button>
        </section>
      )}

      {state === "locked" && (
        <section className="wallet-card" aria-label="Unlock Kakure Wallet">
          <span className="wallet-card-kicker">LOCKED</span>
          <h2>Unlock Kakure Wallet</h2>
          <div className="field">
            <label htmlFor="wallet-unlock-passphrase">Passphrase</label>
            <input id="wallet-unlock-passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </div>
          <button className="primary" type="button" onClick={() => void unlock()}>Unlock</button>
        </section>
      )}

      {state === "unlocked" && walletPublicKey && (
        <div className="wallet-grid">
          <section className="wallet-balance-card">
            <span className="wallet-card-kicker">AVAILABLE</span>
            <strong>{balance === null ? "—" : balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>
            <span>SOL · {cluster === "devnet" ? "Devnet" : "Mainnet"}</span>
            <a href={explorer} target="_blank" rel="noreferrer">Open address in Solana Explorer ↗</a>
          </section>
          <section className="wallet-card">
            <span className="wallet-card-kicker">SELF-CUSTODY ADDRESS</span>
            <CopyLine value={walletPublicKey.toBase58()} label="wallet address" />
            <div className="wallet-actions">
              <button type="button" onClick={() => void downloadBackup()}>Download encrypted backup</button>
              <button type="button" onClick={lock}>Lock wallet</button>
            </div>
          </section>
          <section className="wallet-card wallet-privacy-card">
            <span className="wallet-card-kicker">KAKURE PRIVACY LAYER</span>
            <h2>Public outside. Private inside.</h2>
            <p>The wallet address funds the shielded pool. Inside Kakure, positions become commitments and spends become nullifiers backed by zero-knowledge proofs.</p>
            <div className="wallet-privacy-flow"><span>Wallet</span><b>→</b><span>Shield</span><b>→</b><span>Private portfolio</span></div>
          </section>
        </div>
      )}

      {message && <p className="notice" role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <section className="wallet-assurance" aria-label="Wallet assurances">
        <div><b>Local custody</b><span>Signing keys stay encrypted in this browser.</span></div>
        <div><b>Network separation</b><span>Cluster-specific state prevents cross-network proof reuse.</span></div>
        <div><b>Private by design</b><span>Kakure notes hide positions while retaining selective auditability.</span></div>
      </section>
    </main>
  );
}
