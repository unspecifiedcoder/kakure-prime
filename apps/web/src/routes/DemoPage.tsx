import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMeteoraEvidence,
  fetchPreStocks,
  fetchPythAaplStatus,
  navPremium,
  preStockRisk,
  pythRisk,
  type MeteoraEvidence,
  type PreStock,
  type PythMarketStatus,
} from "../lib/sponsorData.js";

const METEORA_DBC_POOL = "58Hx2oENZDdiZHqsrxbZRNypMQKpt4rGbLGEXy8sTbcW";
const METEORA_EXPLORER_URL = `https://explorer.solana.com/address/${METEORA_DBC_POOL}?cluster=devnet`;
const transactionUrl = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const shorten = (value: string): string => `${value.slice(0, 5)}…${value.slice(-5)}`;

const STEPS = [
  {
    eyebrow: "PORTFOLIO READY",
    title: "Frontier Equity Fund",
    detail: "A 3-of-5 threshold portfolio is ready. No individual signer holds the custody key.",
    action: "Shield 42.50 AAPLx",
  },
  {
    eyebrow: "POSITION SHIELDED",
    title: "AAPLx became a private note",
    detail: "The public transaction reveals a commitment—not the ticker, amount, recipient, or signer graph.",
    action: "Propose private distribution",
  },
  {
    eyebrow: "PROPOSAL CREATED",
    title: "Distribute 12.50 AAPLx",
    detail: "The encrypted proposal is visible only to the portfolio quorum. Three approvals are required.",
    action: "Collect 3 approvals",
  },
  {
    eyebrow: "QUORUM REACHED",
    title: "3 of 5 signers approved",
    detail: "FROST combines signature shares and the prover verifies conservation, ownership, and compliance ciphertext formation.",
    action: "Generate proof & settle",
  },
  {
    eyebrow: "PRIVATE SETTLEMENT FINAL",
    title: "Distribution completed",
    detail: "The recipient can claim 12.50 AAPLx. The chain records only a spent nullifier, new commitment, and valid proof.",
    action: "Replay demo",
  },
] as const;

export function DemoPage(): JSX.Element {
  const [step, setStep] = useState(0);
  const [lane, setLane] = useState<"prestocks" | "aaplx">("prestocks");
  const [preStocks, setPreStocks] = useState<PreStock[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("ANTHROPIC");
  const [pyth, setPyth] = useState<PythMarketStatus | null>(null);
  const [meteora, setMeteora] = useState<MeteoraEvidence | null>(null);
  const current = STEPS[step]!;
  const isFinal = step === STEPS.length - 1;
  const selected = useMemo(() => preStocks.find((stock) => stock.symbol === selectedSymbol), [preStocks, selectedSymbol]);
  const preStocksGate = selected ? preStockRisk(selected) : null;
  const pythGate = pyth ? pythRisk(pyth) : null;
  const asset = lane === "aaplx" ? "AAPLx" : selected?.symbol ?? "AAPLx";
  const assetName = lane === "aaplx" ? "Apple xStock" : selected?.name ?? "Apple xStock";
  const activeGatePassed = lane === "aaplx" ? pythGate?.passed === true : preStocksGate?.passed !== false;
  const activePolicy = lane === "aaplx" ? pythGate?.reason ?? "Verifying Pyth price" : preStocksGate?.reason ?? "Verifying official asset";

  useEffect(() => {
    const controller = new AbortController();
    void fetchPreStocks(controller.signal).then(setPreStocks).catch(() => undefined);
    void fetchPythAaplStatus(controller.signal).then(setPyth).catch(() => undefined);
    void fetchMeteoraEvidence(controller.signal).then(setMeteora).catch(() => undefined);
    return () => controller.abort();
  }, []);

  function advance(): void {
    setStep((value) => (value === STEPS.length - 1 ? 0 : value + 1));
  }

  return (
    <main className="judge-demo">
      <div className="demo-notice" role="note">
        <span>GUIDED JUDGE MODE</span>
        <strong>Live sponsor data + verified devnet evidence · settlement clicks are simulated</strong>
      </div>

      <header className="demo-hero">
        <div>
          <div className="eyebrow">KAKURE PRIME · PRIVATE EQUITY SETTLEMENT</div>
          <h1>Watch public equity become private settlement.</h1>
          <p>
            This guided flow mirrors Kakure Prime's real circuit, FROST, and Solana program architecture without requiring the
            local validator or coordinator used by the full developer demo.
          </p>
        </div>
        <div className="demo-progress" aria-label={`Demo step ${step + 1} of ${STEPS.length}`}>
          <strong>{String(step + 1).padStart(2, "0")}</strong>
          <span>/ {String(STEPS.length).padStart(2, "0")}</span>
        </div>
      </header>

      <section className="integration-evidence" aria-label="Live sponsor integration evidence">
        <article data-state={preStocksGate ? preStocksGate.passed ? "pass" : "block" : "loading"}>
          <div><span>01 · PRESTOCKS</span><b>{preStocksGate ? preStocksGate.passed ? "POLICY PASS" : "POLICY BLOCK" : "VERIFYING"}</b></div>
          <h2>Official-only private equity rail</h2>
          <p>{selected ? `${selected.name} is API-allowlisted, ${selected.onChainVerified ? "Token-2022 verified" : "unverified"}; ${navPremium(selected).toFixed(1)}% token-to-mark spread.` : "Loading the official PreStocks catalog…"}</p>
          {selected && <a href={`https://solscan.io/token/${selected.contractAddress}`} target="_blank" rel="noreferrer">Official mint {shorten(selected.contractAddress)} ↗</a>}
        </article>
        <article data-state={pythGate?.passed ? "pass" : pyth ? "ready" : "loading"}>
          <div><span>02 · PYTH</span><b>{pythGate?.passed ? "RISK PASS" : pyth ? "BROKER READY" : "VERIFYING"}</b></div>
          <h2>AAPLx settlement risk gate</h2>
          <p>{pyth?.price !== null && pyth?.price !== undefined ? `$${pyth.price.toFixed(2)} · ${pythGate?.confidenceBps?.toFixed(1)} bps confidence · ${pythGate?.ageSeconds}s old` : pythGate?.reason ?? "Discovering the canonical feed…"}</p>
          {pyth && <a href={`https://insights.pyth.network/price-feeds/${pyth.feedId}`} target="_blank" rel="noreferrer">Feed {shorten(pyth.feedId)} ↗</a>}
        </article>
        <article data-state={meteora?.verified ? "pass" : "loading"}>
          <div><span>03 · METEORA DBC</span><b>{meteora?.verified ? "ON-CHAIN PASS" : "VERIFYING"}</b></div>
          <h2>Traded equity-receipt curve</h2>
          <p>{meteora ? `${(meteora.curveProgress * 100).toFixed(3)}% curve progress · ${(meteora.quoteReserveLamports / 1e9).toFixed(4)} SOL reserve · ${meteora.graduation}` : "Checking pool ownership and transaction finality…"}</p>
          {meteora && <a href={transactionUrl(meteora.tradeSignature)} target="_blank" rel="noreferrer">Finalized devnet trade {shorten(meteora.tradeSignature)} ↗</a>}
        </article>
      </section>

      <section className="demo-workspace" aria-live="polite">
        <div className="demo-operation">
          <div className="sponsor-controls">
            <label htmlFor="demo-lane">Settlement policy lane</label>
            <select id="demo-lane" value={lane} onChange={(event) => { setLane(event.target.value as "prestocks" | "aaplx"); setStep(0); }}>
              <option value="prestocks">PreStocks · official-only NAV guard</option>
              <option value="aaplx">AAPLx · Pyth price risk gate</option>
            </select>
            {lane === "prestocks" && <>
              <label htmlFor="demo-asset">Official PreStocks asset</label>
              <select id="demo-asset" value={selectedSymbol} onChange={(event) => { setSelectedSymbol(event.target.value); setStep(0); }}>
                {preStocks.length === 0 && <option value="ANTHROPIC">Loading live PreStocks…</option>}
                {preStocks.map((stock) => <option value={stock.symbol} key={stock.contractAddress}>{stock.symbol} · ${stock.tokenPrice.toFixed(2)}</option>)}
              </select>
            </>}
            <div className="sponsor-signals">
              <span><b>PreStocks</b> {preStocksGate ? preStocksGate.reason : "connecting"}</span>
              <span><b>Pyth</b> {pythGate?.reason ?? "verifying feed"}</span>
              <span>
                <b>Meteora DBC</b>{" "}
                <a href={METEORA_EXPLORER_URL} target="_blank" rel="noreferrer" title={METEORA_DBC_POOL}>
                  devnet pool 58Hx…TbcW
                </a>{" "}
                · 100 → 25 bps
              </span>
            </div>
          </div>
          <span className="demo-label">{current.eyebrow}</span>
          <h2>{current.title.replaceAll("AAPLx", asset)}</h2>
          <p>{current.detail.replaceAll("AAPLx", asset)}</p>

          <dl className="demo-ledger">
            <div><dt>Portfolio</dt><dd>Frontier Equity Fund</dd></div>
            <div><dt>Policy</dt><dd>3-of-5 FROST</dd></div>
            <div><dt>Position</dt><dd>{step === 0 ? `42.50 ${asset} public` : step < 4 ? `42.50 ${asset} shielded` : `30.00 ${asset} shielded`}</dd></div>
            <div><dt>Risk policy</dt><dd>{activePolicy}</dd></div>
            <div><dt>Approvals</dt><dd>{step < 3 ? "0 / 3" : "3 / 3 verified"}</dd></div>
          </dl>

          <button className="primary big demo-action" type="button" onClick={advance} disabled={step === 0 && !activeGatePassed}>
            {current.action.replaceAll("AAPLx", asset)} <span aria-hidden="true">→</span>
          </button>
          {step === 0 && !activeGatePassed && <p className="demo-blocked">Settlement blocked by the active sponsor risk policy.</p>}
          {isFinal && <p className="demo-success">Proof verified · settlement final · recipient claim ready</p>}
        </div>

        <div className="demo-visibility">
          <article className="observer-panel">
            <span className="demo-label">WHAT THE PUBLIC CHAIN SEES</span>
            <code>{step === 0 ? `token_transfer(${asset}, 42.50)` : "commitment  0x18f7…91c2"}</code>
            <code>{step < 4 ? "nullifier   —" : "nullifier   0xa922…04df"}</code>
            <code>{step < 4 ? "proof       pending" : "proof       Groth16 ✓"}</code>
            <div className="redacted-grid" aria-label="Redacted public information">
              <span>TICKER <b>{step === 0 ? asset : "████"}</b></span>
              <span>AMOUNT <b>{step === 0 ? "42.50" : "████"}</b></span>
              <span>RECIPIENT <b>████████</b></span>
              <span>SIGNERS <b>█████</b></span>
            </div>
          </article>

          <article className="quorum-panel">
            <span className="demo-label">WHAT THE AUTHORIZED QUORUM SEES</span>
            <div className="equity-position">
              <div><span>{asset}</span><small>{assetName}</small></div>
              <strong>{step === 4 ? "30.00" : "42.50"}</strong>
            </div>
            <div className="approval-dots" aria-label={`${step < 3 ? 0 : 3} of 5 approvals`}>
              {[0, 1, 2, 3, 4].map((index) => <span className={step >= 3 && index < 3 ? "approved" : ""} key={index}>{index + 1}</span>)}
            </div>
            <p>{step < 2 ? "No distribution proposed" : step < 4 ? `12.50 ${asset} → private recipient` : `12.50 ${asset} claim sealed`}</p>
          </article>
        </div>
      </section>

      <ol className="demo-timeline" aria-label="Private settlement stages">
        {STEPS.map((item, index) => (
          <li className={index < step ? "done" : index === step ? "active" : ""} key={item.eyebrow}>
            <span>{index < step ? "✓" : index + 1}</span>
            <div><strong>{item.eyebrow}</strong><small>{index < step ? "Complete" : index === step ? "Current" : "Next"}</small></div>
          </li>
        ))}
      </ol>

      <section className="demo-proof-stack" aria-label="Architecture used by the full implementation">
        <span>PreStocks allowlist + NAV guard</span><b>→</b><span>Pyth freshness + confidence gate</span><b>→</b><span>Noir + FROST proof</span><b>→</b><span>Meteora traded DBC receipt</span>
      </section>

      <p className="demo-footnote">
        The guided data above is simulated for judge accessibility. The repository includes the real circuits, Solana program,
        SDK, services, and local-validator end-to-end flow. <Link to="/security">Read the security model</Link>.
      </p>
    </main>
  );
}
