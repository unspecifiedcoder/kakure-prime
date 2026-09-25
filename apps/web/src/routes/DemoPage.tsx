import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPreStocks, fetchPythAaplStatus, navPremium, type PreStock, type PythMarketStatus } from "../lib/sponsorData.js";

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
  const [preStocks, setPreStocks] = useState<PreStock[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("ANTHROPIC");
  const [pyth, setPyth] = useState<PythMarketStatus | null>(null);
  const current = STEPS[step]!;
  const isFinal = step === STEPS.length - 1;
  const selected = useMemo(() => preStocks.find((stock) => stock.symbol === selectedSymbol), [preStocks, selectedSymbol]);
  const asset = selected?.symbol ?? "AAPLx";
  const assetName = selected?.name ?? "Apple xStock";

  useEffect(() => {
    const controller = new AbortController();
    void fetchPreStocks(controller.signal).then(setPreStocks).catch(() => undefined);
    void fetchPythAaplStatus(controller.signal).then(setPyth).catch(() => undefined);
    return () => controller.abort();
  }, []);

  function advance(): void {
    setStep((value) => (value === STEPS.length - 1 ? 0 : value + 1));
  }

  return (
    <main className="judge-demo">
      <div className="demo-notice" role="note">
        <span>SIMULATED JUDGE MODE</span>
        <strong>No wallet · no real assets · deterministic demo data</strong>
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

      <section className="demo-workspace" aria-live="polite">
        <div className="demo-operation">
          <div className="sponsor-controls">
            <label htmlFor="demo-asset">PreStocks private-market asset</label>
            <select id="demo-asset" value={selectedSymbol} onChange={(event) => { setSelectedSymbol(event.target.value); setStep(0); }}>
              {preStocks.length === 0 && <option value="ANTHROPIC">Loading live PreStocks…</option>}
              {preStocks.map((stock) => <option value={stock.symbol} key={stock.contractAddress}>{stock.symbol} · ${stock.tokenPrice.toFixed(2)}</option>)}
            </select>
            <div className="sponsor-signals">
              <span><b>PreStocks</b> {selected ? `live · ${navPremium(selected).toFixed(1)}% vs mark` : "connecting"}</span>
              <span><b>Pyth</b> {pyth ? `${pyth.symbol} · ${pyth.isOpen ? "24/7 feed live" : "closed"}` : "verifying feed"}</span>
              <span><b>Meteora DBC</b> equity-receipt curve · 30 bps → 5 bps</span>
            </div>
          </div>
          <span className="demo-label">{current.eyebrow}</span>
          <h2>{current.title.replaceAll("AAPLx", asset)}</h2>
          <p>{current.detail}</p>

          <dl className="demo-ledger">
            <div><dt>Portfolio</dt><dd>Frontier Equity Fund</dd></div>
            <div><dt>Policy</dt><dd>3-of-5 FROST</dd></div>
            <div><dt>Position</dt><dd>{step === 0 ? `42.50 ${asset} public` : step < 4 ? `42.50 ${asset} shielded` : `30.00 ${asset} shielded`}</dd></div>
            <div><dt>Approvals</dt><dd>{step < 3 ? "0 / 3" : "3 / 3 verified"}</dd></div>
          </dl>

          <button className="primary big demo-action" type="button" onClick={advance}>
            {current.action} <span aria-hidden="true">→</span>
          </button>
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
        <span>PreStocks asset</span><b>→</b><span>Pyth risk signal</span><b>→</b><span>Noir + FROST proof</span><b>→</b><span>Meteora DBC receipt</span>
      </section>

      <p className="demo-footnote">
        The guided data above is simulated for judge accessibility. The repository includes the real circuits, Solana program,
        SDK, services, and local-validator end-to-end flow. <Link to="/security">Read the security model</Link>.
      </p>
    </main>
  );
}
