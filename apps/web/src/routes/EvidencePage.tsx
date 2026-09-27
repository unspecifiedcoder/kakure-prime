const explorerTx = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const explorerAddress = (address: string): string => `https://explorer.solana.com/address/${address}?cluster=devnet`;

const FLOW = [
  {
    number: "01",
    kind: "PUBLIC BOUNDARY",
    title: "Deposit",
    signature: "4QSDN3RSCUm4eSANet9Qd1BSTgkptdFh8EDRBKF7yRs5w1LnJhhyrDUM2WepxbwrLmazr4Pc543FU2hANz1ec8j4",
    metric: "1.527s proof · 608,868 CU",
    visible: "Source token account and deposit amount",
  },
  {
    number: "02",
    kind: "PRIVATE INTERIOR",
    title: "3-of-5 settlement",
    signature: "2EyosmdTjZ3c7DsgQRBHhGexfEM6JGhGxk1XFJLeAyooPkvuX8yP2iqJjJucC3DeyZqXpeKmgPEvtt13Pqjknwsg",
    metric: "7.765s proof + submit · 615,921 CU",
    visible: "Commitments, ciphertext, nullifier and Groth16 proof",
  },
  {
    number: "03",
    kind: "PUBLIC BOUNDARY",
    title: "Recipient withdrawal",
    signature: "GFuaxgsPVUtPQiKbzb12Enoe583t1jCbXuNrFDbgiZQZKtLRKTZS4Dga3cPHq4VSBuJHiUJiqt7EHo8mf2T9S7m",
    metric: "2.329s proof · 586,902 CU",
    visible: "Destination token account and withdrawal amount",
  },
] as const;

const PROGRAMS = [
  ["POOL", "CTBujgpdNFHAYg9WGDWjgGa68AxYuT1TKQBkRYnv6cBf"],
  ["DEPOSIT VERIFIER", "21sN3juRFvjxBokrkB2tNisFpiRnpXTq42XrzbJ3XtxM"],
  ["3-OF-5 VERIFIER", "CNoKnfajTr8XQXs4D84cy89C993KSn4bs5tXZ9Xmofwb"],
  ["WITHDRAW VERIFIER", "25pR3qcZynCSUxx7atAwahaCih6GeNzEt923YksuPMg4"],
] as const;

export function EvidencePage(): JSX.Element {
  return (
    <main className="evidence-page">
      <header className="evidence-hero">
        <div>
          <span className="eyebrow">PUBLIC SOLANA DEVNET · 2026-09-27</span>
          <h1>The transfer finalized. The strategy stayed private.</h1>
          <p>Three matching Groth16 verifier programs, a dealerless 3-of-5 FROST quorum, recipient-only note discovery, and an exact withdrawal—publicly inspectable end to end.</p>
        </div>
        <div className="evidence-verdict"><strong>9 / 9</strong><span>PASS</span><small>finalized · no transaction errors</small></div>
      </header>

      <section className="evidence-flow" aria-label="Finalized Devnet transaction chain">
        {FLOW.map((stage) => (
          <article className={stage.number === "02" ? "private-stage" : ""} key={stage.number}>
            <div><span>{stage.number}</span><b>{stage.kind}</b></div>
            <h2>{stage.title}</h2>
            <p>{stage.metric}</p>
            <dl><dt>Chain reveals</dt><dd>{stage.visible}</dd></dl>
            {stage.number === "02" && <dl className="hidden-fields"><dt>Chain cannot read</dt><dd>Plaintext asset · value · recipient · signer graph</dd></dl>}
            <a href={explorerTx(stage.signature)} target="_blank" rel="noreferrer">{stage.signature.slice(0, 8)}…{stage.signature.slice(-8)} ↗</a>
          </article>
        ))}
      </section>

      <section className="evidence-rejections" aria-label="Rejected adversarial paths">
        <span>✓ TAMPERED ROOT REJECTED</span>
        <span>✓ SPENT NULLIFIER REPLAY REJECTED</span>
        <span>✓ 2-OF-5 QUORUM REJECTED</span>
      </section>

      <section className="evidence-programs">
        <div><span className="eyebrow">EXECUTABLE PROGRAMS</span><h2>Proof verification happens on Solana.</h2></div>
        <div className="program-list">
          {PROGRAMS.map(([label, address]) => <a href={explorerAddress(address)} target="_blank" rel="noreferrer" key={address}><span>{label}</span><code>{address.slice(0, 8)}…{address.slice(-8)}</code></a>)}
        </div>
      </section>

      <p className="evidence-warning">Pre-release, unaudited, and built with INSECURE-DEV Groth16 parameters. This evidence proves execution—not production security. Never use the deployment with material assets.</p>
    </main>
  );
}
