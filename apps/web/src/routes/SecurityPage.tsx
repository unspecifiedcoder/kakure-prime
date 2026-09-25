/** The page a finance lead reads before pasting a treasury in. Plain words, one table: who can see
 *  what. No marketing. */
export function SecurityPage(): JSX.Element {
  return (
    <main>
      <div className="block">
        <h1>What is private, what is not</h1>
        <p className="lede">
          Payments move inside a shielded pool on Solana. The chain records that a payment happened and a set of
          commitments; it does not record who paid whom, or how much.
        </p>
      </div>
      <div className="block">
        <h2>Who can see what</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Party</th>
                <th>Sees</th>
                <th>Cannot see</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Anyone on a block explorer</td>
                <td>That the pool ran; opaque commitments; the total deposited to and withdrawn from the pool</td>
                <td>Sender, recipient, amount, memo of any payment</td>
              </tr>
              <tr>
                <td>Treasury signers</td>
                <td>Every payment the treasury made or received, with amounts</td>
                <td>Anything about other treasuries or recipients&apos; other income</td>
              </tr>
              <tr>
                <td>Your accountant (scoped view key)</td>
                <td>Payments in the date range you export, read-only</td>
                <td>Anything outside that range; cannot move funds</td>
              </tr>
              <tr>
                <td>A recipient</td>
                <td>Their own payments</td>
                <td>Who else was paid, or how much</td>
              </tr>
              <tr>
                <td>The compliance key holder</td>
                <td>Can decrypt payments if legally required; every payment is provably encrypted to this key</td>
                <td>Cannot move funds</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="block">
        <h2>Who can move the money</h2>
        <p>
          Nobody alone. A treasury is created by its signers together; spending requires the number of approvals you
          chose (for example 3 of 5). There is no single spending key anywhere — not in this browser, not on our
          servers, not with us. The approval itself is checked inside the payment&apos;s proof, so the chain never learns
          which signers approved.
        </p>
      </div>
      <div className="block">
        <h2>What runs where</h2>
        <p>
          Keys are derived from your wallet&apos;s signature and encrypted at rest in this browser with your passphrase.
          Proofs for receiving and withdrawing are generated in your browser. Treasury payments are proved by a helper
          that runs on the signer&apos;s own computer. Our servers relay encrypted messages between signers and index
          public chain data; they never hold keys or funds.
        </p>
      </div>
      <div className="block">
        <h2>Status</h2>
        <p>
          Open source. Internal security review complete; independent audit and bug bounty before mainnet. Circuits use
          a development trusted setup until then — do not hold real funds in this version.
        </p>
      </div>
    </main>
  );
}
