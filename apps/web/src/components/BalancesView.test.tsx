import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BalancesView } from "./BalancesView.js";

describe("BalancesView", () => {
  it("shows a placeholder when there are no balances", () => {
    render(<BalancesView balances={[]} assetMap={{}} />);
    expect(screen.getByText("No balances found.")).toBeInTheDocument();
  });

  it("labels a balance's asset with the asset table entry", () => {
    render(
      <BalancesView
        balances={[{ assetId: "0xabc", total: 4200n }]}
        assetMap={{ "0xabc": "USDC-mint" }}
      />,
    );
    expect(screen.getByText("USDC-mint")).toBeInTheDocument();
    expect(screen.getByText("4200")).toBeInTheDocument();
  });

  it("falls back to the bare asset_id when no label is set", () => {
    render(<BalancesView balances={[{ assetId: "0xdef", total: 1n }]} assetMap={{}} />);
    expect(screen.getByText("0xdef")).toBeInTheDocument();
  });
});
