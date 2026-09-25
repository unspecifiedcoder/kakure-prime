import { useEffect, useState } from "react";
import { fetchRootInfo } from "../lib/rootInfo.js";

export interface RootHeaderProps {
  indexerUrl: string;
  fetchFn?: typeof fetch;
}

/** `GET /root` (I-8): the pool's current root and leaf count, refreshed on mount. */
export function RootHeader({ indexerUrl, fetchFn = fetch }: RootHeaderProps): JSX.Element {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; root: string; nextLeafIndex: number } | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchRootInfo(indexerUrl, fetchFn)
      .then((info) => {
        if (!cancelled) setState({ status: "ready", ...info });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [indexerUrl, fetchFn]);

  return (
    <header aria-label="Pool root">
      {state.status === "loading" && <p>Loading root...</p>}
      {state.status === "error" && <p role="alert">Could not reach indexer at {indexerUrl}</p>}
      {state.status === "ready" && (
        <p>
          Root: <code>{state.root}</code> · Leaves: {state.nextLeafIndex}
        </p>
      )}
    </header>
  );
}
