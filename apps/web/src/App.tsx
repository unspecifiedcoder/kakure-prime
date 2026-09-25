import { HashRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import { Home } from "./routes/Home.js";
import { TreasuryPage } from "./routes/TreasuryPage.js";
import { ClaimPage } from "./routes/ClaimPage.js";
import { AuditPage } from "./routes/AuditPage.js";
import { SecurityPage } from "./routes/SecurityPage.js";
import { DemoPage } from "./routes/DemoPage.js";
import { useAppStore } from "./store/appStore.js";
import { shortAddress } from "./ui/format.js";

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
  const { walletPublicKey, settings } = useAppStore();
  const net = networkLabel(settings.rpcUrl);
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
        <NavLink to="/security">Security</NavLink>
      </nav>
      <span className="spacer" />
      <span className={`badge ${net.live ? "" : "warn"}`} title={settings.rpcUrl}>
        {net.label}
      </span>
      {walletPublicKey && <span className="chip">{shortAddress(walletPublicKey.toBase58())}</span>}
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
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/treasury/:id" element={<TreasuryPage />} />
            <Route path="/claim/:token" element={<ClaimPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/demo" element={<DemoPage />} />
            <Route path="/security" element={<SecurityPage />} />
          </Routes>
        </div>
        <footer className="footer">
          <span>Kakure Prime — confidential equity infrastructure on Solana</span>
          <Link to="/security">What is private and what is not</Link>
          <a href="https://github.com/unspecifiedcoder/kakure-prime" rel="noreferrer">Source code</a>
          <span>Your keys never leave this browser.</span>
        </footer>
      </div>
    </HashRouter>
  );
}
