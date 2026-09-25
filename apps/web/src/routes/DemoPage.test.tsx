import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DemoPage } from "./DemoPage.js";

describe("DemoPage", () => {
  it("runs the complete simulated settlement flow without a wallet or backend", () => {
    render(<MemoryRouter><DemoPage /></MemoryRouter>);
    expect(screen.getByText(/simulated judge mode/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /shield 42.50 AAPLx/i }));
    fireEvent.click(screen.getByRole("button", { name: /propose private distribution/i }));
    fireEvent.click(screen.getByRole("button", { name: /collect 3 approvals/i }));
    fireEvent.click(screen.getByRole("button", { name: /generate proof & settle/i }));
    expect(screen.getByText(/proof verified · settlement final/i)).toBeInTheDocument();
    expect(screen.getByText(/12.50 AAPLx claim sealed/i)).toBeInTheDocument();
  });
});
