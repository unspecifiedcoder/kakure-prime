import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RootHeader } from "./RootHeader.js";

function fakeFetch(root: string, nextLeafIndex: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ root, next_leaf_index: nextLeafIndex, roots: [] }), {
      status: 200,
    })) as typeof fetch;
}

describe("RootHeader", () => {
  it("shows the root and leaf count once loaded", async () => {
    render(<RootHeader indexerUrl="http://x" fetchFn={fakeFetch("0xdeadbeef", 3)} />);
    await waitFor(() => expect(screen.getByText(/0xdeadbeef/)).toBeInTheDocument());
    expect(screen.getByText(/Leaves: 3/)).toBeInTheDocument();
  });

  it("shows an error when the indexer is unreachable", async () => {
    const failing = (async () => new Response("", { status: 500 })) as typeof fetch;
    render(<RootHeader indexerUrl="http://x" fetchFn={failing} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
