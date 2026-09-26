import { lazy, Suspense, useState } from "react";
import { HashRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import { useAppStore } from "./store/appStore.js";
import { shortAddress } from "./ui/format.js";
import { connectPreferredWallet, deriveAccount } from "./lib/wallet.js";

const Home = lazy(() => import("./routes/Home.js").then((module) => ({ default: module.Home })));
const TreasuryPage = lazy(() => import("./routes/TreasuryPage.js").then((module) => ({ default: module.TreasuryPage })));
const ClaimPage = lazy(() => import("./routes/ClaimPage.js").then((module) => ({ default: module.ClaimPage })));
const AuditPage = lazy(() => import("./routes/AuditPage.js").then((module) => ({ default: module.AuditPage })));
const SecurityPage = lazy(() => import("./routes/SecurityPage.js").then((module) => ({ default: module.SecurityPage })));
const DemoPage = lazy(() => import("./routes/DemoPage.js").then((module) => ({ default: module.DemoPage })));
const ExtensionPage = lazy(() => import("./routes/ExtensionPage.js").then((module) => ({ default: module.ExtensionPage })));

/** Which cluster the app is pointed at, read off the RPC URL. A finance lead must never mistake a
 *  devnet demo for real money, so this is always on screen. */
export function networkLabel(rpcUrl: string): { label: string; live: boolean } {
  const u = rpcUrl.toLowerCase();
  if (u.includes("127.0.0.1") || u.includes("localhost")) return { label: "Local test network", live: false };
  if (u.includes("devnet")) return { label: "Devnet", live: false };
  if (u.includes("testnet")) return { label: "Testnet", live: false };
  return { label: "Mainnet", live: true };
}

function TopBar(): JSX.Element {
  const { walletPublicKey, settings, connect, disconnect } = useAppStore();
  const [walletState, setWalletState] = useState<"idle" | "connecting" | "error">("idle");
  const [walletError, setWalletError] = useState("");
  const net = networkLabel(settings.rpcUrl);
  async function onConnect(): Promise<void> {
    setWalletState("connecting");
    setWalletError("");
    try {
      const wallet = await connectPreferredWallet();
      connect(wallet.publicKey, await deriveAccount(wallet));
      setWalletState("idle");
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : String(error));
      setWalletState("error");
    }
  }
  return (
    <header className="topbar">
      <Link to="/" className="wordmark">
        Kakure <span className="prime-mark">Prime</span>
      </Link>
      <nav aria-label="Primary">
        <NavLink to="/" end>
          Portfolios
        </NavLink>
        <NavLink to="/audit">Audit room</NavLink>
        <NavLink to="/demo">Judge demo</NavLink>
        <NavLink to="/wallet">Get extension</NavLink>
        <NavLink to="/security">Security</NavLink>
      </nav>
      <span className="spacer" />
      <span className={`badge ${net.live ? "" : "warn"}`} title={settings.rpcUrl}>
        {net.label}
      </span>
      {walletPublicKey ? (
        <button className="wallet-connect connected" type="button" onClick={disconnect} title="Disconnect wallet">
          <span className="wallet-dot" />{shortAddress(walletPublicKey.toBase58())}
        </button>
      ) : (
        <button className="wallet-connect" type="button" onClick={() => void onConnect()} disabled={walletState === "connecting"} title={walletError || "Connect Kakure Wallet or Phantom"}>
          {walletState === "connecting" ? "Awaiting approval…" : walletState === "error" ? "Install / unlock wallet" : "Connect wallet"}
        </button>
      )}
    </header>
  );
}

/** Spec §1: `/`, `/treasury/:id`, `/claim/:token`, `/audit`. `HashRouter` so `vite preview`/a static
 *  host needs no server-side rewrite rules for deep links (important for the claim link, which is
 *  meant to be opened cold by a recipient with no server config of their own). */
export function App(): JSX.Element {
  return (
    <HashRouter>
      <div className="shell">
        <TopBar />
        <div className="content">
          <Suspense fallback={<p role="status">Loading private-market workspace…</p>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/treasury/:id" element={<TreasuryPage />} />
              <Route path="/claim/:token" element={<ClaimPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/demo" element={<DemoPage />} />
              <Route path="/wallet" element={<ExtensionPage />} />
              <Route path="/security" element={<SecurityPage />} />
            </Routes>
          </Suspense>
        </div>
        <footer className="footer">
          <span>Kakure Prime — confidential equity infrastructure on Solana</span>
          <Link to="/security">What is private and what is not</Link>
          <a href="https://github.com/unspecifiedcoder/kakure-prime" rel="noreferrer">Source code</a>
          <span>Your keys never leave your wallet.</span>
        </footer>
      </div>
    </HashRouter>
  );
}
