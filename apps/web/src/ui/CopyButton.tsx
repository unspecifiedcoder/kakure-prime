import { useState } from "react";

/** A value the person needs to hand to someone else: shown once, copied in one click, never truncated
 *  in the clipboard even when truncated on screen. */
export function CopyLine({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code stays selectable */
    }
  }
  return (
    <div className="copyline">
      <code title={value}>{value}</code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
