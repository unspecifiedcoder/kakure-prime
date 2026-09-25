/** The product's argument in one panel: what a block explorer shows for this payment (opaque
 *  commitments) beside what the person holding the key sees. */
export function PrivacySplit({
  amount,
  caption,
  commitment,
}: {
  amount: string;
  caption: string;
  commitment?: string;
}): JSX.Element {
  const scramble = commitment ?? "0x2f1c…a9e4  0x8b03…77d1  0xc41a…0e2b";
  return (
    <div className="split" role="group" aria-label="What is visible to whom">
      <div className="public">
        <h3>What the blockchain shows</h3>
        <div className="scramble">{scramble}</div>
        <p style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>No sender, no recipient, no amount.</p>
      </div>
      <div className="private">
        <h3>What you see</h3>
        <div className="amount">{amount}</div>
        <p style={{ marginBottom: 0, color: "inherit" }}>{caption}</p>
      </div>
    </div>
  );
}
