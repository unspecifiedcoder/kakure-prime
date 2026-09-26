export function ExtensionPage(): JSX.Element {
  return (
    <main className="extension-page">
      <section className="extension-hero">
        <div>
          <div className="eyebrow">KAKURE WALLET · BROWSER EXTENSION</div>
          <h1>Your Solana wallet—with a private-market layer.</h1>
          <p className="lede">A self-custody extension for public SOL and Kakure shielded positions. Every signature is reviewed in the wallet, never silently approved by the website.</p>
          <div className="actions">
            <a className="btn primary big" href="/downloads/kakure-wallet-extension.zip" download>Download extension</a>
            <a className="btn big" href="https://github.com/unspecifiedcoder/kakure-prime/tree/main/apps/wallet-extension" target="_blank" rel="noreferrer">Inspect source</a>
          </div>
        </div>
        <div className="extension-mock" aria-label="Kakure Wallet extension preview">
          <div className="extension-mock-head"><b>K</b><span>Kakure Wallet<small>PRIVATE-MARKET CUSTODY</small></span><i>DEVNET</i></div>
          <span className="extension-kicker">SOLANA · SELF CUSTODY</span>
          <h2>Public outside.<br/><em>Private inside.</em></h2>
          <div className="extension-vault"><small>SELF-CUSTODY ADDRESS</small><code>7Kak…Prime</code><span>Wallet → Shield → Private position</span></div>
        </div>
      </section>
      <section className="wallet-assurance" aria-label="Extension assurances">
        <div><b>Encrypted locally</b><span>scrypt plus XChaCha20-Poly1305 protects the vault at rest.</span></div>
        <div><b>Review every signature</b><span>Message and transaction requests open a dedicated approval window.</span></div>
        <div><b>Automatic lock</b><span>Decrypted keys are memory-only and cleared after fifteen minutes.</span></div>
      </section>
      <section className="block extension-install">
        <div><span className="eyebrow">INSTALL UNPACKED · CHROME / BRAVE / EDGE</span><h2>Three steps. No seed pasted into a website.</h2></div>
        <ol><li>Download and unzip the extension.</li><li>Open the browser extensions page and enable Developer mode.</li><li>Choose “Load unpacked,” select the unzipped folder, then create or unlock Kakure Wallet.</li></ol>
      </section>
      <p className="demo-footnote">Kakure Wallet is pre-audit software. Use the included Devnet configuration for evaluation; do not custody material mainnet funds until independent security review is complete.</p>
    </main>
  );
}
