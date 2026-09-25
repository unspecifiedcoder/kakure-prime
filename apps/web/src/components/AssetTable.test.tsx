import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssetTable } from "./AssetTable.js";

describe("AssetTable", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders known asset ids and lets the user set a mint label", () => {
    const onChange = vi.fn();
    render(
      <AssetTable assetMap={{}} onChange={onChange} knownAssetIds={["0xabc"]} />,
    );
    expect(screen.getByText("0xabc")).toBeInTheDocument();

    const input = screen.getByLabelText("mint label for 0xabc");
    fireEvent.change(input, { target: { value: "USDC-mint" } });
    expect(onChange).toHaveBeenCalledWith({ "0xabc": "USDC-mint" });
  });

  it("adds a new asset_id -> mint row from the free-text inputs", () => {
    const onChange = vi.fn();
    render(<AssetTable assetMap={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("new asset id"), { target: { value: "0xdef" } });
    fireEvent.change(screen.getByLabelText("new mint label"), { target: { value: "SOL-mint" } });
    fireEvent.click(screen.getByText("add"));
    expect(onChange).toHaveBeenCalledWith({ "0xdef": "SOL-mint" });
  });

  it("removes a row", () => {
    const onChange = vi.fn();
    render(<AssetTable assetMap={{ "0xabc": "USDC" }} onChange={onChange} />);
    fireEvent.click(screen.getByText("remove"));
    expect(onChange).toHaveBeenCalledWith({});
  });
});
