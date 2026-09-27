import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidencePage } from "./EvidencePage.js";

describe("EvidencePage", () => {
  it("links the finalized private lifecycle and states the privacy boundary", () => {
    render(<EvidencePage />);
    expect(screen.getByText(/9 \/ 9/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /2EyosmdT/i })).toHaveAttribute(
      "href",
      expect.stringContaining("2EyosmdTjZ3c7DsgQRBHhGexfEM6JGhGxk1XFJLeAyooPkvuX8yP2iqJjJucC3DeyZqXpeKmgPEvtt13Pqjknwsg"),
    );
    expect(screen.getByText(/plaintext asset · value · recipient · signer graph/i)).toBeInTheDocument();
    expect(screen.getByText(/insecure-dev/i)).toBeInTheDocument();
  });
});
