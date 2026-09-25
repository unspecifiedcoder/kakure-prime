import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NoteHistory } from "./NoteHistory.js";

function fakeFetch(spentByHex: Record<string, boolean>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const hex = url.split("/nullifiers/")[1];
    return new Response(JSON.stringify({ spent: spentByHex[`0x${hex}`] ?? false }), { status: 200 });
  }) as typeof fetch;
}

describe("NoteHistory", () => {
  it("renders leaf index, asset, value, direction, and looks up spent status per nullifier", async () => {
    render(
      <NoteHistory
        notes={[
          { leafIndex: 3, assetId: "0xabc", value: 100n, nullifierHex: "0x01", isIncoming: true },
          { leafIndex: 5, assetId: "0xabc", value: 200n, nullifierHex: "0x02", isIncoming: false },
        ]}
        assetMap={{ "0xabc": "USDC-mint" }}
        indexerUrl="http://x"
        fetchFn={fakeFetch({ "0x02": true })}
      />,
    );

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("USDC-mint")).toHaveLength(2);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("incoming")).toBeInTheDocument();
    expect(screen.getByText("self")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("unspent")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("spent")).toBeInTheDocument());
  });
});
