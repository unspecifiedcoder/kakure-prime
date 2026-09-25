import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuditPage } from "./AuditPage.js";

describe("AuditPage (spec §1.3: read-only, never accepts a spend key)", () => {
  it("renders the single-key and treasury tabs", () => {
    render(<AuditPage />);
    expect(screen.getByRole("tab", { name: /personal view key/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /treasury view key/i })).toBeInTheDocument();
  });

  it("never renders any input labeled or named for a spend key, secret key, or private key", () => {
    render(<AuditPage />);
    const inputs = document.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of Array.from(inputs)) {
      const label = document.querySelector(`label[for="${input.id}"]`)?.textContent ?? "";
      const haystack = `${input.id} ${label}`.toLowerCase();
      expect(haystack).not.toMatch(/spend[- ]?key|secret[- ]?key|private[- ]?key|seed phrase|mnemonic/);
    }
  });

  it("has no input of type=password anywhere on the page", () => {
    render(<AuditPage />);
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it("switching to the treasury tab only ever asks for view-key-shaped fields, never a signing share", () => {
    render(<AuditPage />);
    screen.getByRole("tab", { name: /treasury view key/i }).click();
    expect(screen.queryByLabelText(/secret share|signing key|frost/i)).not.toBeInTheDocument();
  });
});
