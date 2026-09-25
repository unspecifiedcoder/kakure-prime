import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// `globals: false` in vite.config.ts means @testing-library/react's own auto-cleanup (which hooks a
// global `afterEach`) never registers, so each test's rendered tree would otherwise pile up in jsdom's
// shared document across tests in the same file -- exactly what produced the "multiple elements" failures
// in App.test.tsx's multi-render tests.
afterEach(() => {
  cleanup();
});
